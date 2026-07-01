function [vx, vy] = make_region(convex)
%MAKE_REGION  Random 2D sampling region, returned as CCW vertices (VX, VY).
%   MAKE_REGION(true)  — a convex polygon (vertices on a random ellipse).
%   MAKE_REGION(false) — a non-convex "dumbbell": two convex disks joined by a
%                        narrow tube. It is not star-shaped and need not contain
%                        the origin — the sampler finds its own interior start.
if nargin < 1 || isempty(convex)
    convex = true;
end

if convex
    [vx, vy] = convex_region();
else
    [vx, vy] = nonconvex_region();
end

% CCW so the interior is to the left of each edge.
if signed_area(vx, vy) < 0
    vx = vx(end:-1:1);
    vy = vy(end:-1:1);
end
end

function [vx, vy] = convex_region()
% Vertices at increasing angles on an anisotropic, randomly rotated ellipse.
% Points taken in angular order on the ellipse are always in convex position,
% so the polygon is convex by construction — no convhull backend needed (the
% browser worker may not have finished loading it when the figure view
% auto-runs the script). Even angular slots + bounded jitter keep the angles
% ordered and the edges non-degenerate while still random.
m = 6 + randi(4);                       % 7..10 vertices
slot = 2 * pi / m;
ang = (0:m - 1).' * slot + (rand(m, 1) - 0.5) * slot * 0.8;
ex = 1.4 * cos(ang);                    % on an ellipse (anisotropic)
ey = 1.0 * sin(ang);
phi = 2 * pi * rand;                    % random orientation
vx = cos(phi) * ex - sin(phi) * ey;
vy = sin(phi) * ex + cos(phi) * ey;
end

function [vx, vy] = nonconvex_region()
% A "dumbbell": two convex disks (radius r, centers at x = +/-cx) joined by a
% narrow tube of half-width w < r. This is non-convex and non-star-shaped — the
% tube occludes each bulb from the other, so no single point sees the whole
% region — which is what separates the two sampling modes (the local walk mostly
% stays in one bulb, escaping only along a line down the tube; the union walk
% also hops between bulbs along a line that clips both without the tube). Built
% as one CCW loop: the outer (major) arc of each disk, with the straight tube
% edges closing the gaps between the arc ends.
r = 0.52 + 0.12 * rand;         % bulb radius
cx = 0.82 + 0.24 * rand;        % half-distance between bulb centers (> r: disjoint)
w = 0.07 + 0.06 * rand;         % tube half-width (a narrow neck)
w = min(w, 0.5 * r);            % keep the tube clearly narrower than a bulb
gam = asin(w / r);              % half-angle each bulb's tube opening subtends
K = 16;                         % points per bulb arc

% Right bulb: major arc from the bottom opening CCW round to the top opening.
tR = linspace(pi + gam, 3 * pi - gam, K);
rxx = cx + r * cos(tR);
ryy = r * sin(tR);
% Left bulb: major arc from the top opening CCW round to the bottom opening.
tL = linspace(gam, 2 * pi - gam, K);
lxx = -cx + r * cos(tL);
lyy = r * sin(tL);

% Concatenate; the jumps arc-end -> next-arc-start are the straight tube edges.
px = [rxx, lxx].';
py = [ryy, lyy].';

phi = 2 * pi * rand;            % random overall orientation
vx = cos(phi) * px - sin(phi) * py;
vy = sin(phi) * px + cos(phi) * py;
end

function A = signed_area(vx, vy)
%SIGNED_AREA  Shoelace area; positive when the vertices run counterclockwise.
n = numel(vx);
A = 0;
for i = 1:n
    j = mod(i, n) + 1;
    A = A + (vx(i) * vy(j) - vx(j) * vy(i));
end
A = A / 2;
end
