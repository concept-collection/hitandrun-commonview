function [sx, sy] = hit_and_run_general(vx, vy, N, nBurn, local)
%HIT_AND_RUN_GENERAL  Hit-and-run for an arbitrary simple polygon (convex or
%   non-convex). Along each random line it finds *every* crossing of the polygon
%   boundary, so concavities are handled correctly (unlike the convex-only chord
%   in hit_and_run.m). The region need not be star-shaped or contain the origin,
%   so it starts from an interior point found by rejection.
%
%   LOCAL (default false) selects how the step samples along that line:
%     false — sample uniformly across the *union* of all in-region segments the
%             line makes (standard hit-and-run; uniform on the whole region).
%     true  — sample only within the single in-region segment that contains the
%             current point (a local walk that can't jump across a concavity;
%             it does not sample the region uniformly).
%
%   This runs in the numbl interpreter (sort + point-in-polygon tests don't
%   JIT), so it's used only for the non-convex demo at modest N.
if nargin < 5 || isempty(local)
    local = false;
end
nv = numel(vx);
[px, py] = interior_seed(vx, vy);
total = nBurn + N;
sx = zeros(N, 1);
sy = zeros(N, 1);

for step = 1:total
    th = 2 * pi * rand;
    dx = cos(th);
    dy = sin(th);

    % All parameters t where the line p + t*d crosses the polygon boundary.
    ts = zeros(1, nv);
    m = 0;
    for i = 1:nv
        j = mod(i, nv) + 1;
        ex = vx(j) - vx(i);
        ey = vy(j) - vy(i);
        denom = dy * ex - dx * ey;
        if abs(denom) < 1e-12
            continue
        end
        wx = vx(i) - px;
        wy = vy(i) - py;
        sParam = (dx * wy - dy * wx) / denom;   % position along the edge
        if sParam >= 0 && sParam < 1
            m = m + 1;
            ts(m) = (wy * ex - wx * ey) / denom;  % position along the line
        end
    end
    if m < 2
        continue
    end
    ts = sort(ts(1:m));

    if local
        % Local segment: the in-region interval straddling t = 0, i.e. bounded
        % by the nearest crossing on each side of the current (interior) point.
        tlo = -inf;
        thi = inf;
        for k = 1:m
            if ts(k) <= 0 && ts(k) > tlo
                tlo = ts(k);
            elseif ts(k) >= 0 && ts(k) < thi
                thi = ts(k);
            end
        end
        if ~isfinite(tlo) || ~isfinite(thi) || thi <= tlo
            continue
        end
        tpick = tlo + (thi - tlo) * rand;
    else
        % In-region intervals are consecutive crossings whose midpoint is
        % inside; sample uniformly across their union.
        totalLen = 0;
        for k = 1:m - 1
            tm = (ts(k) + ts(k + 1)) / 2;
            if point_in_poly(px + tm * dx, py + tm * dy, vx, vy)
                totalLen = totalLen + (ts(k + 1) - ts(k));
            end
        end
        if totalLen <= 0
            continue
        end
        u = totalLen * rand;
        tpick = 0;
        for k = 1:m - 1
            tm = (ts(k) + ts(k + 1)) / 2;
            if point_in_poly(px + tm * dx, py + tm * dy, vx, vy)
                len = ts(k + 1) - ts(k);
                if u <= len
                    tpick = ts(k) + u;
                    break
                end
                u = u - len;
            end
        end
    end
    px = px + tpick * dx;
    py = py + tpick * dy;

    if step > nBurn
        sx(step - nBurn) = px;
        sy(step - nBurn) = py;
    end
end
end

function [px, py] = interior_seed(vx, vy)
%INTERIOR_SEED  A point strictly inside polygon (VX, VY), by rejection sampling
%   its bounding box. The polygon fills a large fraction of the box, so this
%   lands quickly; the vertex mean is a fallback if it somehow doesn't.
minx = min(vx); maxx = max(vx);
miny = min(vy); maxy = max(vy);
px = mean(vx); py = mean(vy);
for t = 1:5000
    qx = minx + (maxx - minx) * rand;
    qy = miny + (maxy - miny) * rand;
    if point_in_poly(qx, qy, vx, vy)
        px = qx;
        py = qy;
        return
    end
end
end

function inside = point_in_poly(x, y, vx, vy)
%POINT_IN_POLY  Ray-casting test for a point against polygon (VX, VY).
n = numel(vx);
inside = false;
j = n;
for i = 1:n
    if ((vy(i) > y) ~= (vy(j) > y)) && ...
            (x < (vx(j) - vx(i)) * (y - vy(i)) / (vy(j) - vy(i)) + vx(i))
        inside = ~inside;
    end
    j = i;
end
end
