PROGRAM   := serter
SRC_DIR   := src
BUILD_DIR := build

# set CARAVEL_INCLUDE env var or adjust here
CARAVEL_INCLUDE ?= $(HOME)/.local/share/caravel/include

# set CLANG/LLD env vars to override
CLANG ?= $(HOME)/.cache/solana/v1.51/platform-tools/llvm/bin/clang
LLD   ?= $(HOME)/.cache/solana/v1.51/platform-tools/llvm/bin/ld.lld

CFLAGS  := --target=sbf -fPIC -O2 -fno-builtin -I$(CARAVEL_INCLUDE)
LDFLAGS := -z notext -shared --Bdynamic $(CARAVEL_INCLUDE)/bpf.ld --entry entrypoint

SRCS := $(wildcard $(SRC_DIR)/*.c)
OBJS := $(patsubst $(SRC_DIR)/%.c,$(BUILD_DIR)/%.o,$(SRCS))
SO   := $(BUILD_DIR)/program.so

.PHONY: all build clean test deploy

all: build

build: $(SO)
	@echo "  Build complete: $(SO)"

$(BUILD_DIR)/%.o: $(SRC_DIR)/%.c | $(BUILD_DIR)
	$(CLANG) $(CFLAGS) -c $< -o $@

$(SO): $(OBJS)
	$(LLD) $(LDFLAGS) -o $@ $^

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

clean:
	rm -rf $(BUILD_DIR)

test: build
	cd tests && npm install && npm test

deploy: build
	solana program deploy $(SO)
