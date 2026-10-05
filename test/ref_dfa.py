"""Independent reference implementation of FatMaxxer's alpha1v2 (dense numpy), used to
cross-validate js/dfa.js. Mirrors MainActivity.java: smoothness priors (dense inverse),
cumsum, hard-coded scales, forward+backward boxes, polyfit log2/log2."""
import json, sys, math
import numpy as np

SCALES = [3,4,4,4,4,5,5,5,5,6,6,6,7,7,7,8,8,9,9,9,10,10,11,12,12,13,13,14,15,15]

def smoothness_priors(x, lam=500):
    x = np.asarray(x, float); T = len(x)
    I = np.eye(T)
    D2 = np.zeros((T-2, T))
    for i in range(T-2):
        D2[i, i] = 1; D2[i, i+1] = -2; D2[i, i+2] = 1
    M = I - np.linalg.inv(I + (lam*lam) * (D2.T @ D2))
    return M @ x

def rms_detrended(y, scale):
    n = len(y); nb = n // scale
    ax = np.arange(scale)
    out = []
    off = 0
    for _ in range(nb):
        seg = y[off:off+scale]; co = np.polyfit(ax, seg, 1); fit = np.polyval(co, ax)
        out.append(math.sqrt(np.mean((seg-fit)**2))); off += scale
    off = n - scale
    for _ in range(nb):
        seg = y[off:off+scale]; co = np.polyfit(ax, seg, 1); fit = np.polyval(co, ax)
        out.append(math.sqrt(np.mean((seg-fit)**2))); off -= scale
    return np.array(out)

def dfa(x, scales=SCALES):
    x = np.asarray(x, float)
    y = np.cumsum(x - x.mean())
    fl = np.array([math.sqrt(np.mean(rms_detrended(y, s)**2)) for s in scales])
    co = np.polyfit(np.log2(scales), np.log2(fl), 1)
    return float(co[0])

def alpha1v2(rr, lam=500):
    return dfa(smoothness_priors(rr, lam))

if __name__ == "__main__":
    req = json.load(sys.stdin)
    out = {}
    for k, arr in req.items():
        if k.startswith("raw:"):
            out[k] = dfa(arr)
        elif k.startswith("sp:"):
            out[k] = smoothness_priors(arr).tolist()
        else:
            out[k] = alpha1v2(arr)
    json.dump(out, sys.stdout)
