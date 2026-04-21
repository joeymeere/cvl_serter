import { expect } from "chai";
import {
  LiteSVM,
  FailedTransactionMetadata,
  TransactionMetadata,
} from "litesvm";
import {
  AccountRole,
  address,
  getAddressEncoder,
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  signTransaction,
  type Instruction,
  type Transaction,
} from "@solana/kit";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const TOKEN_PROGRAM = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSVAR_INSTRUCTIONS = address(
  "Sysvar1nstructions1111111111111111111111111"
);

const IX_SETUP = 0;
const IX_ASSERT = 1;

const TOKEN_ACCOUNT_LEN = 165;
const MINT_LEN = 82;
const TOKEN_IX_MINT_TO = 7;

const encoder = getAddressEncoder();

function pubkeyBytes(a: Address): Uint8Array {
  return new Uint8Array(encoder.encode(a));
}

function mintAccountData(mintAuthority: Address, decimals = 6): Uint8Array {
  const data = new Uint8Array(MINT_LEN);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 1, true); // mint_authority_option = Some
  data.set(pubkeyBytes(mintAuthority), 4);
  dv.setBigUint64(36, 0n, true); // supply
  data[44] = decimals;
  data[45] = 1; // is_initialized
  dv.setUint32(46, 0, true); // freeze_authority_option = None
  return data;
}

function tokenAccountData(
  mint: Address,
  owner: Address,
  amount: bigint
): Uint8Array {
  const data = new Uint8Array(TOKEN_ACCOUNT_LEN);
  data.set(pubkeyBytes(mint), 0);
  data.set(pubkeyBytes(owner), 32);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  data[108] = 1; // initialized
  return data;
}

function mintToIx(
  mint: Address,
  dest: Address,
  authority: Address,
  amount: bigint
): Instruction {
  const data = new Uint8Array(9);
  data[0] = TOKEN_IX_MINT_TO;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  return {
    programAddress: TOKEN_PROGRAM,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: dest, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

async function buildTx(
  svm: LiteSVM,
  feePayer: Address,
  signerKeys: CryptoKeyPair[],
  ixs: Instruction[]
): Promise<Transaction> {
  const msg = pipe(
    createTransactionMessage({ version: "legacy" }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m)
  );
  return await signTransaction(signerKeys, compileTransaction(msg));
}

describe("serter", () => {
  const programPath = path.join(__dirname, "..", "build", "program.so");

  let programId: Address;
  let svm: LiteSVM;

  let payerKeys: CryptoKeyPair;
  let payerAddr: Address;

  let mintAddr: Address;
  let ownerAddr: Address;
  let tokenAcctAddr: Address;
  let scratchKeys: CryptoKeyPair;
  let scratchAddr: Address;

  let lastResult: TransactionMetadata | FailedTransactionMetadata | undefined;

  beforeEach(async () => {
    lastResult = undefined;
    const programKeys = await generateKeyPair();
    programId = await getAddressFromPublicKey(programKeys.publicKey);

    svm = new LiteSVM();
    svm.addProgram(programId, fs.readFileSync(programPath));

    payerKeys = await generateKeyPair();
    payerAddr = await getAddressFromPublicKey(payerKeys.publicKey);
    svm.airdrop(payerAddr, lamports(10_000_000_000n));

    const mintKeys = await generateKeyPair();
    mintAddr = await getAddressFromPublicKey(mintKeys.publicKey);

    const ownerKeys = await generateKeyPair();
    ownerAddr = await getAddressFromPublicKey(ownerKeys.publicKey);

    const taKeys = await generateKeyPair();
    tokenAcctAddr = await getAddressFromPublicKey(taKeys.publicKey);

    scratchKeys = await generateKeyPair();
    scratchAddr = await getAddressFromPublicKey(scratchKeys.publicKey);
  });

  function seedMint() {
    svm.setAccount({
      address: mintAddr,
      lamports: lamports(1_461_600n),
      data: mintAccountData(payerAddr) as unknown as Uint8Array,
      programAddress: TOKEN_PROGRAM,
      executable: false,
      space: BigInt(MINT_LEN),
    });
  }

  function seedTokenAccount(amount: bigint, ownerKey: Address = TOKEN_PROGRAM) {
    svm.setAccount({
      address: tokenAcctAddr,
      lamports: lamports(2_039_280n),
      data: tokenAccountData(mintAddr, ownerAddr, amount) as unknown as Uint8Array,
      programAddress: ownerKey,
      executable: false,
      space: BigInt(TOKEN_ACCOUNT_LEN),
    });
  }

  function setupIx(tokenAcct: Address = tokenAcctAddr): Instruction {
    return {
      programAddress: programId,
      accounts: [
        { address: payerAddr, role: AccountRole.WRITABLE_SIGNER },
        { address: tokenAcct, role: AccountRole.READONLY },
        { address: scratchAddr, role: AccountRole.WRITABLE_SIGNER },
        { address: SYSVAR_INSTRUCTIONS, role: AccountRole.READONLY },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([IX_SETUP]),
    };
  }

  function assertIx(tokenAcct: Address = tokenAcctAddr): Instruction {
    return {
      programAddress: programId,
      accounts: [
        { address: payerAddr, role: AccountRole.WRITABLE_SIGNER },
        { address: tokenAcct, role: AccountRole.READONLY },
        { address: scratchAddr, role: AccountRole.WRITABLE },
      ],
      data: new Uint8Array([IX_ASSERT]),
    };
  }

  async function send(
    signers: CryptoKeyPair[],
    ixs: Instruction[]
  ) {
    const tx = await buildTx(svm, payerAddr, signers, ixs);
    lastResult = svm.sendTransaction(tx);
    return lastResult;
  }

  afterEach(function () {
    if (!lastResult) return;
    const failed = lastResult instanceof FailedTransactionMetadata;
    const meta = failed
      ? (lastResult as FailedTransactionMetadata).meta()
      : (lastResult as TransactionMetadata);
    const status = failed
      ? `FAIL (${(lastResult as FailedTransactionMetadata).err().toString()})`
      : "OK";
    const cu = meta.computeUnitsConsumed();
    const logs = meta.logs();
    // eslint-disable-next-line no-console
    console.log(
      `\n  ── ${this.currentTest?.title ?? ""} ──\n  status: ${status}` +
        `\n  cu: ${cu}\n  logs:\n${logs.map((l) => `    ${l}`).join("\n")}\n`
    );
  });

  it("setup fails when no assert ix follows", async () => {
    seedTokenAccount(100n);
    const res = await send([payerKeys, scratchKeys], [setupIx()]);
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("setup fails when the token account is not owned by the token program", async () => {
    seedTokenAccount(100n, SYSTEM_PROGRAM);
    const res = await send(
      [payerKeys, scratchKeys],
      [setupIx(), assertIx()]
    );
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("assert fails when the balance did not increase", async () => {
    seedTokenAccount(100n);
    const res = await send(
      [payerKeys, scratchKeys],
      [setupIx(), assertIx()]
    );
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("assert fails when the token account passed differs from setup", async () => {
    seedTokenAccount(100n);

    const otherKeys = await generateKeyPair();
    const otherAddr = await getAddressFromPublicKey(otherKeys.publicKey);
    svm.setAccount({
      address: otherAddr,
      lamports: lamports(2_039_280n),
      data: tokenAccountData(mintAddr, ownerAddr, 100n) as unknown as Uint8Array,
      programAddress: TOKEN_PROGRAM,
      executable: false,
      space: BigInt(TOKEN_ACCOUNT_LEN),
    });

    const res = await send(
      [payerKeys, scratchKeys],
      [setupIx(tokenAcctAddr), assertIx(otherAddr)]
    );
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("assert alone (no prior setup) fails", async () => {
    seedTokenAccount(100n);
    const res = await send([payerKeys], [assertIx()]);
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("setup + mint_to + assert succeeds and closes scratch", async () => {
    seedMint();
    seedTokenAccount(100n);

    const res = await send(
      [payerKeys, scratchKeys],
      [setupIx(), mintToIx(mintAddr, tokenAcctAddr, payerAddr, 50n), assertIx()]
    );
    expect(res, (res as FailedTransactionMetadata).toString?.()).not.to.be
      .instanceOf(FailedTransactionMetadata);

    const scratch = svm.getAccount(scratchAddr);
    if (scratch.exists) {
      expect(scratch.lamports).to.equal(0n);
    }

    const ta = svm.getAccount(tokenAcctAddr);
    if (!ta.exists) throw new Error("token account missing");
    const bytes = ta.data as Uint8Array;
    const amount = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(
      64,
      true
    );
    expect(amount).to.equal(150n);
  });

  it("setup finds the assert ix even when non-adjacent", async () => {
    seedMint();
    seedTokenAccount(100n);

    const sinkKeys = await generateKeyPair();
    const sinkAddr = await getAddressFromPublicKey(sinkKeys.publicKey);

    const transferData = new Uint8Array(12);
    new DataView(transferData.buffer).setUint32(0, 2, true);
    new DataView(transferData.buffer).setBigUint64(4, 1_000_000n, true);
    const transferIx: Instruction = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        { address: payerAddr, role: AccountRole.WRITABLE_SIGNER },
        { address: sinkAddr, role: AccountRole.WRITABLE },
      ],
      data: transferData,
    };

    const res = await send(
      [payerKeys, scratchKeys],
      [
        setupIx(),
        transferIx,
        mintToIx(mintAddr, tokenAcctAddr, payerAddr, 25n),
        assertIx(),
      ]
    );
    if (res instanceof FailedTransactionMetadata) {
      throw new Error(res.toString());
    }
  });
});
