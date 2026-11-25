#!/usr/bin/python3
"""Run a PDF utility without sockets or inherited application credentials."""

import ctypes
import errno
import os
import platform
import sys


class Instruction(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint),
    ]


class Program(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Instruction))]


def deny_sockets():
    # Audit architecture and socket, socketpair, bind, listen, accept, connect, accept4.
    architectures = {
        "aarch64": (0xC00000B7, (198, 199, 200, 201, 202, 203, 242)),
        "x86_64": (0xC000003E, (41, 53, 49, 50, 43, 42, 288)),
    }
    machine = platform.machine()
    if machine not in architectures:
        raise RuntimeError("Unsupported syscall ABI for the reader")
    architecture, socket_syscalls = architectures[machine]
    load_word = 0x20
    jump_equal = 0x15
    result = 0x06
    kill_process = 0x80000000
    allow = 0x7FFF0000
    deny = 0x00050000 | errno.EPERM
    code = [
        Instruction(load_word, 0, 0, 4),
        Instruction(jump_equal, 1, 0, architecture),
        Instruction(result, 0, 0, kill_process),
        Instruction(load_word, 0, 0, 0),
    ]
    if machine == "x86_64":
        # The x32 ABI shares the x86-64 audit architecture and sets this syscall bit.
        jump_bit_set = 0x45
        x32_syscall_bit = 0x40000000
        code.extend([
            Instruction(jump_bit_set, 0, 1, x32_syscall_bit),
            Instruction(result, 0, 0, kill_process),
        ])
    for syscall in socket_syscalls:
        code.extend([Instruction(jump_equal, 0, 1, syscall), Instruction(result, 0, 0, deny)])
    code.append(Instruction(result, 0, 0, allow))
    filters = (Instruction * len(code))(*code)
    program = Program(len(code), filters)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = (ctypes.c_int,) + (ctypes.c_ulong,) * 4
    if libc.prctl(38, 1, 0, 0, 0) or libc.prctl(22, 2, ctypes.addressof(program), 0, 0):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def main():
    name = os.path.basename(sys.argv[0])
    if name not in {"pdfinfo", "pdftoppm", "pdftotext", "tesseract"}:
        raise RuntimeError("Unknown reader utility")
    cpu = sorted(os.sched_getaffinity(0))
    os.sched_setaffinity(0, cpu[:2])
    deny_sockets()
    env = {"PATH": "/usr/bin:/bin", "LANG": "C", "LC_ALL": "C", "OMP_THREAD_LIMIT": "1"}
    if os.environ.get("TMPDIR"):
        env["TMPDIR"] = os.environ["TMPDIR"]
    os.execve("/usr/bin/" + name, [name, *sys.argv[1:]], env)


if __name__ == "__main__":
    main()
