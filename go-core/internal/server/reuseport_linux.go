//go:build linux && !mips && !mipsle && !mips64 && !mips64le && !loong64

package server

// Linux SO_REUSEPORT on the common arches (386, amd64, arm, arm64,
// ppc64, ppc64le, riscv64, s390x). The mips* and loong64 variants use
// a different value (0x200) — covered by reuseport_linux_mips.go.
const soReusePortValue = 0xf
