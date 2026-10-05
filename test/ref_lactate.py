"""Independent reference for lactate threshold methods (numpy), to cross-check js/lactate.js."""
import json, sys, math
import numpy as np

def curve(xs, ys):
    d = 3 if len(xs) >= 5 else (2 if len(xs) >= 3 else 1)
    co = np.polyfit(xs, ys, d)
    return lambda x: np.polyval(co, x)

def first_cross(f, x0, x1, level):
    grid = np.linspace(x0, x1, 20001)
    v = f(grid) - level
    if v[0] >= 0: return float(x0)
    idx = np.argmax(v >= 0)
    if v[idx] < 0: return float('nan')
    # linear refine
    xa, xb = grid[idx-1], grid[idx]; va, vb = v[idx-1], v[idx]
    return float(xa + (xb-xa) * (-va)/(vb-va))

def lt1_baseline(xs, ys, delta=0.5):
    i = int(np.argmin(ys)); level = ys[i] + delta
    f = curve(xs, ys)
    return first_cross(f, xs[i], xs[-1], level)

def loglog(xs, ys):
    lx, ly = np.log(xs), np.log(ys)
    best = None
    for k in range(2, len(xs)-1):
        p1 = np.polyfit(lx[:k], ly[:k], 1); p2 = np.polyfit(lx[k:], ly[k:], 1)
        sse = np.sum((ly[:k]-np.polyval(p1, lx[:k]))**2) + np.sum((ly[k:]-np.polyval(p2, lx[k:]))**2)
        if best is None or sse < best[0]: best = (sse, p1, p2)
    _, p1, p2 = best
    lxb = (p2[1]-p1[1])/(p1[0]-p2[0])
    x = math.exp(lxb)
    if x < xs[0] or x > xs[-1]: return float('nan')
    return x

def perp_max(f, xa, xb):
    ya, yb = f(xa), f(xb); dx, dy = xb-xa, yb-ya; L = math.hypot(dx, dy)
    grid = np.linspace(xa, xb, 20001); y = f(grid)
    d = ((grid-xa)*dy - (y-ya)*dx)/L
    return float(grid[int(np.argmax(d))])

def dmax(xs, ys):
    f = curve(xs, ys); return perp_max(f, xs[0], xs[-1])

def moddmax(xs, ys):
    f = curve(xs, ys); xa = loglog(xs, ys)
    if not (xa == xa):
        xa = xs[0]
        for i in range(1, len(xs)):
            if ys[i]-ys[i-1] > 0.4: xa = xs[i-1]; break
    return perp_max(f, xa, xs[-1])

def obla(xs, ys, level):
    f = curve(xs, ys); return first_cross(f, xs[0], xs[-1], level)

if __name__ == "__main__":
    req = json.load(sys.stdin); out = {}
    for name, st in req.items():
        xs = np.array([s['x'] for s in st], float); ys = np.array([s['la'] for s in st], float)
        out[name] = {"lt1b": lt1_baseline(xs, ys), "loglog": loglog(xs, ys), "dmax": dmax(xs, ys),
                     "moddmax": moddmax(xs, ys), "obla4": obla(xs, ys, 4), "obla2": obla(xs, ys, 2)}
    json.dump(out, sys.stdout)
