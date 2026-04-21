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
  getProgramDerivedAddress,
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

const IX_INIT = 0;
const IX_SETUP = 1;
const IX_ASSERT = 2;

const TOKEN_ACCOUNT_LEN = 165;
const MINT_LEN = 82;
const TOKEN_IX_MINT_TO = 7;

const SCRATCH_SEED = new TextEncoder().encode("scratch");

const encoder = getAddressEncoder();

function pubkeyBytes(a: Address): Uint8Array {
  return new Uint8Array(encoder.encode(a));
}

function mintAccountData(mintAuthority: Address, decimals = 6): Uint8Array {
  const data = new Uint8Array(MINT_LEN);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 1, true);
  data.set(pubkeyBytes(mintAuthority), 4);
  dv.setBigUint64(36, 0n, true);
  data[44] = decimals;
  data[45] = 1;
  dv.setUint32(46, 0, true);
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
  data[108] = 1;
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

  let scratchAddr: Address;
  let scratchBump: number;

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

    const [pda, bump] = await getProgramDerivedAddress({
      programAddress: programId,
      seeds: [SCRATCH_SEED, pubkeyBytes(payerAddr)],
    });
    scratchAddr = pda;
    scratchBump = bump;
  });

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
      data: tokenAccountData(
        mintAddr,
        ownerAddr,
        amount
      ) as unknown as Uint8Array,
      programAddress: ownerKey,
      executable: false,
      space: BigInt(TOKEN_ACCOUNT_LEN),
    });
  }

  function initIx(): Instruction {
    return {
      programAddress: programId,
      accounts: [
        { address: payerAddr, role: AccountRole.WRITABLE_SIGNER },
        { address: scratchAddr, role: AccountRole.WRITABLE },
        { address: SYSTEM_PROGRAM, role: AccountRole.READONLY },
      ],
      data: new Uint8Array([IX_INIT, scratchBump]),
    };
  }

  function setupIx(tokenAcct: Address = tokenAcctAddr): Instruction {
    return {
      programAddress: programId,
      accounts: [
        { address: payerAddr, role: AccountRole.WRITABLE_SIGNER },
        { address: tokenAcct, role: AccountRole.READONLY },
        { address: scratchAddr, role: AccountRole.WRITABLE },
        { address: SYSVAR_INSTRUCTIONS, role: AccountRole.READONLY },
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
  ): Promise<TransactionMetadata | FailedTransactionMetadata> {
    const tx = await buildTx(svm, payerAddr, signers, ixs);
    lastResult = svm.sendTransaction(tx);
    return lastResult;
  }

  async function runInit() {
    const res = await send([payerKeys], [initIx()]);
    if (res instanceof FailedTransactionMetadata) {
      throw new Error(`init failed: ${res.toString()}`);
    }
  }

  it("init creates the scratch PDA", async () => {
    await runInit();
    const s = svm.getAccount(scratchAddr);
    expect(s.exists).to.be.true;
  });

  it("init called twice fails (account already exists)", async () => {
    await runInit();

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

    const res = await send([payerKeys], [transferIx, initIx()]);
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("setup fails when no assert ix follows", async () => {
    await runInit();
    seedTokenAccount(100n);
    const res = await send([payerKeys], [setupIx()]);
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("setup fails when the token account is not owned by the token program", async () => {
    await runInit();
    seedTokenAccount(100n, SYSTEM_PROGRAM);
    const res = await send([payerKeys], [setupIx(), assertIx()]);
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("assert fails when the balance did not increase", async () => {
    await runInit();
    seedTokenAccount(100n);
    const res = await send([payerKeys], [setupIx(), assertIx()]);
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("assert fails when the token account passed differs from setup", async () => {
    await runInit();
    seedTokenAccount(100n);

    const otherKeys = await generateKeyPair();
    const otherAddr = await getAddressFromPublicKey(otherKeys.publicKey);
    svm.setAccount({
      address: otherAddr,
      lamports: lamports(2_039_280n),
      data: tokenAccountData(
        mintAddr,
        ownerAddr,
        100n
      ) as unknown as Uint8Array,
      programAddress: TOKEN_PROGRAM,
      executable: false,
      space: BigInt(TOKEN_ACCOUNT_LEN),
    });

    const res = await send(
      [payerKeys],
      [setupIx(tokenAcctAddr), assertIx(otherAddr)]
    );
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("assert alone (no prior setup in this tx) fails on zeroed scratch", async () => {
    await runInit();
    seedTokenAccount(100n);
    const res = await send([payerKeys], [assertIx()]);
    expect(res).to.be.instanceOf(FailedTransactionMetadata);
  });

  it("setup + mint_to + assert succeeds and leaves scratch reusable", async () => {
    await runInit();
    seedMint();
    seedTokenAccount(100n);

    const before = svm.getAccount(scratchAddr);
    if (!before.exists) throw new Error("scratch missing after init");
    const scratchLamportsBefore = before.lamports;

    const res = await send(
      [payerKeys],
      [setupIx(), mintToIx(mintAddr, tokenAcctAddr, payerAddr, 50n), assertIx()]
    );
    if (res instanceof FailedTransactionMetadata) {
      throw new Error(res.toString());
    }

    const after = svm.getAccount(scratchAddr);
    if (!after.exists) throw new Error("scratch was closed unexpectedly");
    expect(after.lamports).to.equal(scratchLamportsBefore);

    const data = after.data as Uint8Array;
    expect([...data.slice(0, 40)].every((b) => b === 0)).to.equal(true);

    const ta = svm.getAccount(tokenAcctAddr);
    if (!ta.exists) throw new Error("token account missing");
    const bytes = ta.data as Uint8Array;
    const amount = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(
      64,
      true
    );
    expect(amount).to.equal(150n);
  });

  it("scratch PDA can be reused across multiple setup/assert cycles", async () => {
    await runInit();
    seedMint();
    seedTokenAccount(100n);

    const r1 = await send(
      [payerKeys],
      [setupIx(), mintToIx(mintAddr, tokenAcctAddr, payerAddr, 50n), assertIx()]
    );
    if (r1 instanceof FailedTransactionMetadata) throw new Error(r1.toString());

    const r2 = await send(
      [payerKeys],
      [
        setupIx(),
        mintToIx(mintAddr, tokenAcctAddr, payerAddr, 100n),
        assertIx(),
      ]
    );
    if (r2 instanceof FailedTransactionMetadata) throw new Error(r2.toString());

    const ta = svm.getAccount(tokenAcctAddr);
    if (!ta.exists) throw new Error("token account missing");
    const bytes = ta.data as Uint8Array;
    const amount = new DataView(bytes.buffer, bytes.byteOffset).getBigUint64(
      64,
      true
    );
    expect(amount).to.equal(250n);
  });

  it("setup finds the assert ix even when non-adjacent", async () => {
    await runInit();
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
      [payerKeys],
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
