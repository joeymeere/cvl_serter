#include <caravel.h>
#include "state.h"
#include "instructions.h"

#define TOKEN_ACCOUNT_AMOUNT_OFFSET 64
#define TOKEN_AMOUNT(acc) \
    (*(const uint64_t *)((acc)->data + TOKEN_ACCOUNT_AMOUNT_OFFSET))

#define ERR_NO_FOLLOWING_ASSERT    ERROR_CUSTOM(100)
#define ERR_BALANCE_NOT_GREATER    ERROR_CUSTOM(101)
#define ERR_TOKEN_ACCOUNT_MISMATCH ERROR_CUSTOM(102)

#define INIT_ACCOUNTS(X) \
    X(payer,          SIGNER | WRITABLE) \
    X(scratch,        WRITABLE) \
    X(system_program, PROGRAM)

#define SETUP_ACCOUNTS(X) \
    X(signer,              SIGNER | WRITABLE) \
    X(token_account,       0) \
    X(scratch,             WRITABLE) \
    X(instructions_sysvar, 0)

#define ASSERT_ACCOUNTS(X) \
    X(signer,        SIGNER | WRITABLE) \
    X(token_account, 0) \
    X(scratch,       WRITABLE)

typedef struct __attribute__((packed)) {
    uint8_t bump;
} init_args_t;

IX(IX_DISC_INIT,   init,   INIT_ACCOUNTS, init_args_t)
IX(IX_DISC_SETUP,  setup,  SETUP_ACCOUNTS)
IX(IX_DISC_ASSERT, assert, ASSERT_ACCOUNTS)

static uint64_t init(
    init_accounts_t *ctx, init_args_t *args, Parameters *params
) {
    Rent rent;
    get_rent(&rent);
    uint64_t lamports = minimum_balance(&rent, sizeof(ScratchState));

    SignerSeed seeds[3] = {
        SEED_STR(SCRATCH_SEED),
        SEED_PUBKEY(ctx->payer->key),
        SEED_U8(&args->bump),
    };
    SignerSeeds signer_seeds = { .seeds = seeds, .len = 3 };

    TRY(system_create_account_signed(
        ctx->payer, ctx->scratch,
        lamports, sizeof(ScratchState), params->program_id,
        params->accounts, (int)params->accounts_len,
        &signer_seeds, 1
    ));

    return SUCCESS;
}

static uint64_t setup(
    setup_accounts_t *ctx, setup_args_t *args, Parameters *params
) {
    (void)args;

    ASSERT_OWNER(ctx->token_account, &TOKEN_PROGRAM_ID);
    if (ctx->token_account->data_len < sizeof(TokenAccount))
        return ERROR_INVALID_ACCOUNT_DATA;

    ASSERT_OWNER(ctx->scratch, params->program_id);
    ASSERT_DATA_LEN(ctx->scratch, sizeof(ScratchState));

    InstructionsSysvar sysvar = {
        .data     = ctx->instructions_sysvar->data,
        .data_len = ctx->instructions_sysvar->data_len,
    };
    uint16_t current = instructions_current_index(&sysvar);
    uint16_t total   = instructions_count(&sysvar);

    /* moonwalk le buffer */
    bool found = false;
    for (int32_t i = (int32_t)total - 1; i > (int32_t)current; i--) {
        LoadedInstruction ix;
        TRY(instructions_get(&sysvar, (uint16_t)i, &ix));
        if (ix.data_len >= 1 &&
            ix.data[0] == IX_DISC_ASSERT &&
            pubkey_eq(ix.program_id, params->program_id)) {
            found = true;
            break;
        }
    }
    if (!found) return ERR_NO_FOLLOWING_ASSERT;

    ScratchState *state = ACCOUNT_STATE(ctx->scratch, ScratchState);
    state->recorded_balance = TOKEN_AMOUNT(ctx->token_account);
    pubkey_cpy(state->token_account.bytes, ctx->token_account->key->bytes);

    return SUCCESS;
}

static uint64_t assert(
    assert_accounts_t *ctx, assert_args_t *args, Parameters *params
) {
    (void)args;

    ASSERT_OWNER(ctx->scratch, params->program_id);
    ASSERT_DATA_LEN(ctx->scratch, sizeof(ScratchState));

    ScratchState *state = ACCOUNT_STATE(ctx->scratch, ScratchState);

    if (!pubkey_eq(ctx->token_account->key, &state->token_account))
        return ERR_TOKEN_ACCOUNT_MISMATCH;

    if (TOKEN_AMOUNT(ctx->token_account) <= state->recorded_balance)
        return ERR_BALANCE_NOT_GREATER;

    /* keep pda alive, but zero data for next setup */
    uint64_t *w = (uint64_t *)ctx->scratch->data;
    w[0] = 0; w[1] = 0; w[2] = 0; w[3] = 0; w[4] = 0;

    return SUCCESS;
}

ENTRYPOINT(
    HANDLER(init)
    HANDLER(setup)
    HANDLER(assert)
)
