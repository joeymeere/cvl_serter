#include <caravel.h>
#include "state.h"
#include "instructions.h"

#define TOKEN_ACCOUNT_AMOUNT_OFFSET 64
#define TOKEN_AMOUNT(acc) \
    (*(const uint64_t *)((acc)->data + TOKEN_ACCOUNT_AMOUNT_OFFSET))

#define SETUP_ACCOUNTS(X) \
    X(signer,              SIGNER | WRITABLE) \
    X(token_account,       0) \
    X(scratch,             SIGNER | WRITABLE) \
    X(instructions_sysvar, 0) \
    X(system_program,      PROGRAM)

#define ASSERT_ACCOUNTS(X) \
    X(signer,        SIGNER | WRITABLE) \
    X(token_account, 0) \
    X(scratch,       WRITABLE)

IX(IX_DISC_SETUP,  setup,  SETUP_ACCOUNTS)
IX(IX_DISC_ASSERT, assert, ASSERT_ACCOUNTS)

static uint64_t setup(
    setup_accounts_t *ctx, setup_args_t *args, Parameters *params
) {
    (void)args;

    ASSERT_OWNER(ctx->token_account, &TOKEN_PROGRAM_ID);
    if (ctx->token_account->data_len < sizeof(TokenAccount)) {
        return ERROR_INVALID_ACCOUNT_DATA;
    }

    InstructionsSysvar sysvar = {
        .data     = ctx->instructions_sysvar->data,
        .data_len = ctx->instructions_sysvar->data_len,
    };

    uint16_t current = instructions_current_index(&sysvar);
    uint16_t total   = instructions_count(&sysvar);

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
    if (!found) {
        return ERR_NO_FOLLOWING_ASSERT;
    }

    Rent rent;
    get_rent(&rent);
    uint64_t lamports = minimum_balance(&rent, sizeof(ScratchState));

    TRY(system_create_account(
        ctx->signer, ctx->scratch,
        lamports, sizeof(ScratchState), params->program_id,
        params->accounts, (int)params->accounts_len
    ));

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

    if (!pubkey_eq(ctx->token_account->key, &state->token_account)) {
        return ERR_TOKEN_ACCOUNT_MISMATCH;
    }

    if (TOKEN_AMOUNT(ctx->token_account) <= state->recorded_balance) {
        return ERR_BALANCE_NOT_GREATER;
    }

    uint64_t scratch_lamports = *ctx->scratch->lamports;
    *ctx->scratch->lamports = 0;
    *ctx->signer->lamports  = *ctx->signer->lamports + scratch_lamports;
    // sol_memset_(ctx->scratch->data, 0, ctx->scratch->data_len);

    return SUCCESS;
}

ENTRYPOINT(
    HANDLER(setup)
    HANDLER(assert)
)
