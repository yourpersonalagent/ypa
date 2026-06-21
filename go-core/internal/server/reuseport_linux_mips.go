//go:build linux && (mips || mipsle || mips64 || mips64le || loong64)

package server

// MIPS-family and LoongArch Linux use a different SO_REUSEPORT value.
const soReusePortValue = 0x200
