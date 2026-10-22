#!/usr/bin/env python3
"""
tappy's sound effects, synthesised from scratch (no samples, nothing licensed).

    python3 packages/app/scripts/make-sounds.py

Writes `packages/app/assets/sounds/*.wav` (mono, 44.1 kHz, 16-bit). WAV on
purpose: AAC pads the start of a file with ~45 ms of silence, and the goal
launch's charge has to finish on the exact frame Ken blows.

One palette for all of them so they sound like one thing: soft FM bells and
sine tones in D major pentatonic (D E F# A B), filtered noise for air, and one
small shared room. The timings are the app's own: `charge` is HOLD_MS long
with a tick on each of the ring's 24 dots, `burst` lands with the blast and
`reveal` with the opening (`launchFx.ts`, `NewGoalSheet.tsx`).

Needs numpy and scipy. Deterministic: the same script writes the same files.
"""
import os
import sys

import numpy as np
from scipy.io import wavfile
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "sounds")
RNG = np.random.default_rng(7)

# Must match NewGoalSheet.tsx (HOLD_MS) and launchFx.ts (RING_DOTS).
HOLD_S = 1.6
RING_DOTS = 24

# D major pentatonic, from D3 up.
def note(semis_from_d3: float) -> float:
    return 146.83 * 2 ** (semis_from_d3 / 12)

PENTA = [0, 2, 4, 7, 9]  # D E F# A B
def penta(i: int) -> float:
    return note(PENTA[i % 5] + 12 * (i // 5))


def t_axis(dur: float) -> np.ndarray:
    return np.arange(int(dur * SR)) / SR


def osc(freq, dur: float) -> np.ndarray:
    """A sine whose frequency may change over time (array or scalar)."""
    n = int(dur * SR)
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    return np.sin(2 * np.pi * np.cumsum(f) / SR)


def bell(freq: float, dur: float, bright: float = 1.0, decay: float = 4.0) -> np.ndarray:
    """A soft FM bell: carrier with an inharmonic modulator whose depth dies away."""
    t = t_axis(dur)
    index = bright * 1.3 * np.exp(-t * decay * 1.6)
    mod = np.sin(2 * np.pi * freq * 3.5 * t)
    env = np.exp(-t * decay) * np.minimum(1, t / 0.003)
    return np.sin(2 * np.pi * freq * t + index * mod) * env


def noise(dur: float) -> np.ndarray:
    return RNG.standard_normal(int(dur * SR))


def band(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    sos = butter(order, [lo, min(hi, SR / 2 - 100)], btype="band", fs=SR, output="sos")
    return sosfilt(sos, x)


def low(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, hz, btype="low", fs=SR, output="sos"), x)


def high(x: np.ndarray, hz: float, order: int = 2) -> np.ndarray:
    return sosfilt(butter(order, hz, btype="high", fs=SR, output="sos"), x)


def sweep_band(x: np.ndarray, lo: np.ndarray, hi: np.ndarray, blocks: int = 48) -> np.ndarray:
    """Band-pass with moving edges, block by block with crossfades."""
    n = len(x)
    out = np.zeros(n)
    size = n // blocks + 1
    win = np.hanning(size * 2)
    for b in range(blocks + 1):
        start = max(0, b * size - size)
        end = min(n, b * size + size)
        if end <= start:
            continue
        k = min(n - 1, b * size)
        seg = band(x[start:end], float(lo[k]), float(hi[k]))
        out[start:end] += seg * win[: end - start]
    return out


def place(dst: np.ndarray, src: np.ndarray, at: float, gain: float = 1.0) -> None:
    i = int(at * SR)
    if i >= len(dst):
        return
    j = min(len(dst), i + len(src))
    dst[i:j] += src[: j - i] * gain


def fade(x: np.ndarray, fin: float = 0.004, fout: float = 0.02) -> np.ndarray:
    x = x.copy()
    a = int(fin * SR)
    b = int(fout * SR)
    if a:
        x[:a] *= np.linspace(0, 1, a)
    if b:
        x[-b:] *= np.linspace(1, 0, b)
    return x


# One small room for everything.
_IR_T = t_axis(0.9)
ROOM = noise(0.9) * np.exp(-_IR_T * 6.5)
ROOM = low(ROOM, 6000)
ROOM /= np.sqrt(np.sum(ROOM**2))


def room(x: np.ndarray, wet: float = 0.18, tail: float = 0.5) -> np.ndarray:
    padded = np.concatenate([x, np.zeros(int(tail * SR))])
    w = fftconvolve(padded, ROOM)[: len(padded)]
    return padded * (1 - wet * 0.4) + w * wet


def master(x: np.ndarray, peak_db: float) -> np.ndarray:
    """Soft-clip, then set the peak level. Quiet by default: these are UI sounds."""
    x = np.tanh(x * 1.2)
    x = x / (np.max(np.abs(x)) + 1e-9)
    return x * 10 ** (peak_db / 20)


def write(name: str, x: np.ndarray, peak_db: float) -> None:
    x = master(fade(x), peak_db)
    os.makedirs(OUT, exist_ok=True)
    wavfile.write(os.path.join(OUT, f"{name}.wav"), SR, (x * 32767).astype(np.int16))
    print(f"{name:14s} {len(x) / SR:5.2f}s")


# --- The goal launch ---------------------------------------------------------

def charge() -> np.ndarray:
    """Hold: a tone climbing three octaves, air rising with it, a tick per ring dot."""
    dur = HOLD_S
    t = t_axis(dur)
    u = t / dur
    f = 110 * 2 ** (3 * u**1.25)
    trem_rate = 5 + 26 * u**2
    trem = 0.75 + 0.25 * np.sin(2 * np.pi * np.cumsum(trem_rate) / SR)
    tone = (osc(f, dur) + 0.35 * osc(f * 2, dur) + 0.12 * osc(f * 3.01, dur)) * (0.08 + 0.55 * u**1.6) * trem
    sub = osc(55 + 30 * u, dur) * 0.25 * u**2
    air = sweep_band(noise(dur), 700 + 3000 * u**1.5, 1100 + 4500 * u**1.5) * (0.01 + 0.16 * u**2.4)
    x = tone + sub + air
    for k in range(RING_DOTS):
        at = (k + 1) / RING_DOTS * dur - 0.01
        x_tick = bell(penta(5 + k // 2), 0.08, bright=0.6, decay=40)
        place(x, x_tick, at, 0.18 + 0.32 * (k / RING_DOTS))
    # Cut clean at the blast: the burst takes over on the same frame.
    x[-int(0.012 * SR):] *= np.linspace(1, 0, int(0.012 * SR))
    return room(x, wet=0.12, tail=0.05)


def drain() -> np.ndarray:
    """Let go early: the charge winds down."""
    dur = 0.42
    t = t_axis(dur)
    u = t / dur
    tone = osc(660 * 2 ** (-2.2 * u), dur) * (1 - u) ** 1.5
    air = low(noise(dur), 2500) * 0.15 * (1 - u) ** 2
    return room(tone * 0.6 + air, wet=0.2, tail=0.3)


def burst() -> np.ndarray:
    """The blast: a deep thump, a crack, a ringing chord and sparks raining down."""
    dur = 2.4
    t = t_axis(dur)
    x = np.zeros(len(t))
    # Thump: a sine falling from 120 to 38 Hz.
    thump_f = 38 + 82 * np.exp(-t * 9)
    x += osc(thump_f, dur) * np.exp(-t * 3.2) * 1.3
    # Crack: noise, bright for a moment, then dark.
    crack = noise(dur)
    x += high(crack, 900) * np.exp(-t * 38) * 0.9
    x += low(crack, 1800) * np.exp(-t * 6) * 0.35
    # Chord: D major, bells, opening out.
    for i, semis in enumerate([0, 7, 12, 16, 19, 24]):
        place(x, bell(note(semis), 2.2, bright=0.8, decay=1.6), 0.01 * i, 0.22)
    # Sparks: high pentatonic bells, dense at first and thinning out.
    for k in range(70):
        at = 0.04 + 1.7 * (RNG.random() ** 1.8)
        f = penta(10 + int(RNG.integers(0, 9)))
        place(x, bell(f, 0.35, bright=0.5, decay=11), at, 0.08 * (1 - at / 1.9))
    return room(x, wet=0.28, tail=0.6)


def reveal() -> np.ndarray:
    """The opening: air rushing out and a chord blooming as the session appears."""
    dur = 1.3
    t = t_axis(dur)
    u = np.minimum(1, t / 0.9)
    swell = np.sin(np.pi * np.minimum(1, t / 1.0)) ** 1.5
    air = sweep_band(noise(dur), 300 + 2200 * u, 700 + 4000 * u) * 0.22 * swell
    pad = np.zeros(len(t))
    for semis in (12, 16, 19, 24):
        pad += osc(note(semis) * (1 + 0.002 * RNG.standard_normal()), dur)
    pad *= 0.12 * np.minimum(1, t / 0.45) * np.exp(-np.maximum(0, t - 0.5) * 3)
    x = air + pad
    place(x, bell(note(36), 0.8, bright=0.7, decay=5), 0.42, 0.35)
    place(x, bell(note(31), 0.8, bright=0.6, decay=5), 0.5, 0.2)
    return room(x, wet=0.3, tail=0.6)


# --- The thinking dial -------------------------------------------------------

LEVEL_STEPS = 5


def level_up(i: int) -> np.ndarray:
    """A two-note blip, climbing the scale with the level."""
    dur = 0.32
    x = np.zeros(int(dur * SR))
    base = 7 + 2 * i
    place(x, bell(penta(base), 0.25, bright=0.9, decay=14), 0, 0.6)
    place(x, bell(penta(base + 2), 0.28, bright=1.0, decay=12), 0.055, 0.7)
    return room(x, wet=0.2, tail=0.3)


def level_max() -> np.ndarray:
    """The top: the blip, then a run of sparkle."""
    x = np.concatenate([level_up(LEVEL_STEPS - 1), np.zeros(int(0.6 * SR))])
    for k in range(7):
        place(x, bell(penta(17 + k), 0.4, bright=0.6, decay=9), 0.1 + k * 0.045, 0.22 * (1 - k / 9))
    return room(x, wet=0.25, tail=0.3)


def level_down(i: int) -> np.ndarray:
    """A soft falling glide, lower with the level."""
    dur = 0.26
    t = t_axis(dur)
    f0 = penta(9 + 2 * i)
    tone = osc(f0 * 2 ** (-0.6 * t / dur), dur) * np.exp(-t * 14) * np.minimum(1, t / 0.004)
    return room(tone * 0.7, wet=0.22, tail=0.3)


# --- Everyday ----------------------------------------------------------------

def send() -> np.ndarray:
    """A message leaves: a soft 'tappy'."""
    dur = 0.16
    t = t_axis(dur)
    f = 420 + 1700 * np.exp(-t * 30)
    tone = (osc(f, dur) + 0.25 * osc(f * 2, dur)) * np.exp(-t * 22) * np.minimum(1, t / 0.002)
    air = high(noise(dur), 3000) * np.exp(-t * 60) * 0.12
    return room(tone + air, wet=0.12, tail=0.2)


def done() -> np.ndarray:
    """A reply finished: two bell notes, settling."""
    x = np.zeros(int(0.9 * SR))
    place(x, bell(note(19), 0.7, bright=0.7, decay=5), 0, 0.5)
    place(x, bell(note(24), 0.8, bright=0.8, decay=4), 0.09, 0.6)
    return room(x, wet=0.25, tail=0.4)


def attention() -> np.ndarray:
    """The agent needs you: a rising three-note ping, a little more present."""
    x = np.zeros(int(0.9 * SR))
    for k, semis in enumerate((24, 28, 31)):
        place(x, bell(note(semis), 0.6, bright=1.0, decay=6), k * 0.075, 0.55)
    return room(x, wet=0.22, tail=0.4)


def main() -> None:
    write("charge", charge(), -4)
    write("drain", drain(), -10)
    write("burst", burst(), -1.5)
    write("reveal", reveal(), -6)
    for i in range(LEVEL_STEPS):
        write(f"level-up-{i}", level_up(i), -9)
        write(f"level-down-{i}", level_down(i), -12)
    write("level-max", level_max(), -7)
    write("send", send(), -12)
    write("done", done(), -9)
    write("attention", attention(), -6)


if __name__ == "__main__":
    sys.exit(main())
