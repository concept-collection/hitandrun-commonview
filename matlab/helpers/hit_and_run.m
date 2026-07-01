function [sx, sy] = hit_and_run(vx, vy, N, nBurn)
%HIT_AND_RUN  Draw N uniform samples from a convex polygon by hit-and-run.
%   [SX, SY] = HIT_AND_RUN(VX, VY, N, NBURN) draws N samples (after NBURN
%   burn-in steps) from the uniform distribution on the convex polygon with
%   counterclockwise vertices (VX, VY).
%
%   Represents the polygon as a set of half-planes (inside iff n_i . p >= c_i
%   for every edge i). From the current interior point, pick a random
%   direction, intersect the line with every half-plane to get the chord
%   [tmin, tmax], then jump to a uniform-random point on it.
%

% Guard: this hot loop must JS-JIT-compile (it's ~30x slower in the
% interpreter).
%!numbl:assert_jit

nv = numel(vx);

% Inward half-plane form for each edge: the left normal of a CCW edge points
% into the interior.
nx = zeros(nv, 1);
ny = zeros(nv, 1);
c  = zeros(nv, 1);
for i = 1:nv
    j = mod(i, nv) + 1;
    ex = vx(j) - vx(i);
    ey = vy(j) - vy(i);
    len = hypot(ex, ey);
    n1 = -ey / len;
    n2 =  ex / len;
    nx(i) = n1;
    ny(i) = n2;
    c(i)  = n1 * vx(i) + n2 * vy(i);
end

% Start at the centroid (always interior for a convex polygon).
px = mean(vx);
py = mean(vy);

total = nBurn + N;
sx = zeros(N, 1);
sy = zeros(N, 1);
for s = 1:total
    th = 2 * pi * rand;
    dx = cos(th);
    dy = sin(th);
    % Chord [tmin, tmax] of the line p + t*d that stays inside the region.
    tmin = -inf;
    tmax =  inf;
    for i = 1:nv
        a = nx(i) * dx + ny(i) * dy;
        rhs = c(i) - (nx(i) * px + ny(i) * py);   % <= 0 since p is interior
        if a > 1e-12
            tmin = max(tmin, rhs / a);
        elseif a < -1e-12
            tmax = min(tmax, rhs / a);
        end
    end
    t = tmin + (tmax - tmin) * rand;
    px = px + t * dx;
    py = py + t * dy;
    if s > nBurn
        sx(s - nBurn) = px;
        sy(s - nBurn) = py;
    end
end
end
