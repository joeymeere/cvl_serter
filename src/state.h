#ifndef SERTER_STATE_H
#define SERTER_STATE_H

#include <caravel.h>

STATE(ScratchState)
typedef struct {
    uint64_t recorded_balance;
    Pubkey   token_account;
} ScratchState;

#define ERR_NO_FOLLOWING_ASSERT    ERROR_CUSTOM(100)
#define ERR_BALANCE_NOT_GREATER    ERROR_CUSTOM(101)
#define ERR_TOKEN_ACCOUNT_MISMATCH ERROR_CUSTOM(102)

#endif /* SERTER_STATE_H */
