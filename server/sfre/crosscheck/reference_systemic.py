"""
Independent, stdlib-only reference implementations for the vNext systemic engines
(server/src/sfre/tests/vnextCrosscheck.test.js). Written from the equations in docs/sfre/VNEXT_SYSTEMIC.md using
DIFFERENT algorithms than the JavaScript code wherever possible:
  * clearing: Rogers-Veraart default-set iteration + Gaussian elimination (JS: monotone fixed-point iteration)
  * normal cdf / inverse: statistics.NormalDist (JS: series / continued fraction + Acklam/Halley)
  * herding N_eff: Jacobi eigenvalues (JS: trace formula)
  * optimal AMM split: greedy chunk routing (JS: bisection on the common marginal price)
  * wrong-way expected loss: midpoint-rule quadrature (JS: Simpson on both sides of the kink)
  * bond: exact cash-flow repricing with finite-difference duration/convexity (JS: second-order formula)
Reads {"op": ..., "args": ...} JSON on stdin; writes {"result": ...} JSON on stdout.
"""
import json
import math
import sys
from statistics import NormalDist

N = NormalDist()


def gauss_solve(a, b):
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        p = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[p][c]) < 1e-14:
            raise ValueError("singular")
        m[c], m[p] = m[p], m[c]
        for r in range(c + 1, n):
            f = m[r][c] / m[c][c]
            for k in range(c, n + 1):
                m[r][k] -= f * m[c][k]
    x = [0.0] * n
    for i in range(n - 1, -1, -1):
        x[i] = (m[i][n] - sum(m[i][k] * x[k] for k in range(i + 1, n))) / m[i][i]
    return x


def clearing(n, ext, ext_liab, edges, alpha, beta):
    """Rogers-Veraart: grow the default set D, solve the linear system for payments of D, repeat. edges: [c, d, amount]."""
    lbar = [ext_liab[i] for i in range(n)]
    for c, d, a in edges:
        lbar[d] += a
    pi = [[0.0] * n for _ in range(n)]  # pi[j][i]: share of j's payment that goes to creditor i
    for c, d, a in edges:
        if lbar[d] > 0:
            pi[d][c] += a / lbar[d]
    D = set()
    while True:
        p = list(lbar)
        idx = sorted(D)
        if idx:
            k = len(idx)
            A = [[0.0] * k for _ in range(k)]
            rhs = [0.0] * k
            for r, i in enumerate(idx):
                A[r][r] += 1.0
                rhs[r] = alpha * ext[i]
                for j in range(n):
                    coef = beta * pi[j][i]
                    if coef == 0.0:
                        continue
                    if j in D:
                        A[r][idx.index(j)] -= coef
                    else:
                        rhs[r] += coef * lbar[j]
            sol = gauss_solve(A, rhs)
            for r, i in enumerate(idx):
                p[i] = sol[r]
        assets = [ext[i] + sum(pi[j][i] * p[j] for j in range(n)) for i in range(n)]
        newD = {i for i in range(n) if lbar[i] > 0 and assets[i] < lbar[i] - 1e-9}
        if newD <= D:
            equity = [0.0 if i in D else assets[i] - lbar[i] for i in range(n)]
            return {"p": p, "lbar": lbar, "defaulted": sorted(D), "equity": equity}
        D |= newD


def vasicek(pd, rho, g):
    return N.cdf((N.inv_cdf(pd) - math.sqrt(rho) * g) / math.sqrt(1 - rho))


def probit_shift(pd, shift):
    return N.cdf(N.inv_cdf(pd) + shift)


def bond(coupon, maturity, y, dy):
    """Exact annual-pay bond repricing; duration/convexity from central differences of the exact price."""
    def price(yy):
        return sum(coupon / (1 + yy) ** t for t in range(1, maturity + 1)) + 100.0 / (1 + yy) ** maturity
    h = 1e-5
    p0 = price(y)
    d1 = (price(y + h) - price(y - h)) / (2 * h)
    d2 = (price(y + h) - 2 * p0 + price(y - h)) / (h * h)
    dur = -d1 / p0
    conv = d2 / p0
    return {"duration": dur, "convexity": conv, "taylor": 1 - dur * dy + 0.5 * conv * dy * dy, "exact": price(y + dy) / p0}


def amm_out(x, y, fee, dx):
    dx_eff = dx * (1 - fee)
    return y - x * y / (x + dx_eff)


def split_greedy(pools, q, chunks=40000):
    """Route q in tiny chunks to the pool with the best marginal price (fees ignored) -> optimal split as chunks->inf."""
    st = [[x, y] for x, y in pools]
    step = q / chunks
    out = 0.0
    for _ in range(chunks):
        j = max(range(len(st)), key=lambda i: st[i][1] / st[i][0])
        x, y = st[j]
        o = y - x * y / (x + step)
        st[j] = [x + step, y - o]
        out += o
    return out


def jacobi_eigs(a, sweeps=100):
    n = len(a)
    m = [row[:] for row in a]
    for _ in range(sweeps):
        off = sum(m[i][j] ** 2 for i in range(n) for j in range(n) if i != j)
        if off < 1e-24:
            break
        for p in range(n - 1):
            for q in range(p + 1, n):
                if abs(m[p][q]) < 1e-18:
                    continue
                th = (m[q][q] - m[p][p]) / (2 * m[p][q])
                t = (1 if th >= 0 else -1) / (abs(th) + math.sqrt(th * th + 1))
                c = 1 / math.sqrt(t * t + 1)
                s = t * c
                for k in range(n):
                    mkp, mkq = m[k][p], m[k][q]
                    m[k][p], m[k][q] = c * mkp - s * mkq, s * mkp + c * mkq
                for k in range(n):
                    mpk, mqk = m[p][k], m[q][k]
                    m[p][k], m[q][k] = c * mpk - s * mqk, s * mpk + c * mqk
    return [m[i][i] for i in range(len(a))]


def n_eff(rows):
    X = []
    for r in rows:
        nr = math.sqrt(sum(v * v for v in r))
        X.append([v / nr for v in r])
    G = [[sum(a * b for a, b in zip(X[i], X[j])) for j in range(len(X))] for i in range(len(X))]
    lam = jacobi_eigs(G)
    return sum(lam) ** 2 / sum(v * v for v in lam)


def epe(a, b):
    """E[max(0, a+bx)] by midpoint quadrature (independent of the closed form)."""
    n, lo, hi = 400000, -12.0, 12.0
    h = (hi - lo) / n
    s = 0.0
    for i in range(n):
        x = lo + (i + 0.5) * h
        v = a + b * x
        if v > 0:
            s += v * math.exp(-0.5 * x * x)
    return s * h / math.sqrt(2 * math.pi)


def wwr_el(a, b, pd, lgd, rho):
    n, lo, hi = 400000, -12.0, 12.0
    h = (hi - lo) / n
    cp = N.inv_cdf(pd)
    s = 0.0
    for i in range(n):
        x = lo + (i + 0.5) * h
        v = a + b * x
        if v > 0:
            s += v * N.cdf((cp + math.copysign(math.sqrt(abs(rho)), rho) * x) / math.sqrt(1 - rho)) * math.exp(-0.5 * x * x)
    return lgd * s * h / math.sqrt(2 * math.pi)


def waterfall(loss, im, df_def, sitg, survivors, cap_mult):
    """Single-defaulter default waterfall; survivors: list of default-fund contributions."""
    layers = {}
    rem = loss
    for name, avail in (("im", im), ("df_defaulter", df_def), ("sitg", sitg)):
        used = min(rem, avail)
        layers[name] = used
        rem -= used
    pool = sum(survivors)
    used = min(rem, pool)
    layers["df_survivors"] = used
    rem -= used
    cap = sum(cap_mult * s for s in survivors)
    used = min(rem, cap)
    layers["assessments"] = used
    rem -= used
    layers["unfunded"] = rem
    return layers


def covenant_repay(debt, assets, cov, delta):
    denom = 1 - cov / (1 - delta)
    return (debt - cov * assets) / denom


def normal_ops(args):
    return {"cdf": [N.cdf(x) for x in args["x"]], "inv": [N.inv_cdf(p) for p in args["p"]]}


OPS = {
    "clearing": lambda a: clearing(a["n"], a["ext"], a["extLiab"], a["edges"], a["alpha"], a["beta"]),
    "vasicek": lambda a: vasicek(a["pd"], a["rho"], a["g"]),
    "probit_shift": lambda a: probit_shift(a["pd"], a["shift"]),
    "bond": lambda a: bond(a["coupon"], a["maturity"], a["y"], a["dy"]),
    "amm_out": lambda a: amm_out(a["x"], a["y"], a["fee"], a["dx"]),
    "split_greedy": lambda a: split_greedy([tuple(p) for p in a["pools"]], a["q"]),
    "n_eff": lambda a: n_eff(a["rows"]),
    "epe": lambda a: epe(a["a"], a["b"]),
    "wwr_el": lambda a: wwr_el(a["a"], a["b"], a["pd"], a["lgd"], a["rho"]),
    "waterfall": lambda a: waterfall(a["loss"], a["im"], a["df_def"], a["sitg"], a["survivors"], a["cap_mult"]),
    "covenant_repay": lambda a: covenant_repay(a["debt"], a["assets"], a["cov"], a["delta"]),
    "normal": normal_ops,
    "im": lambda a: N.inv_cdf(a["q"]) * a["sigma"] * math.sqrt(a["mpor"]),
}

if __name__ == "__main__":
    req = json.load(sys.stdin)
    json.dump({"result": OPS[req["op"]](req["args"])}, sys.stdout)
