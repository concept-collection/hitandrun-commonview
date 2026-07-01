function hitandrun_sampler(N)
%HITANDRUN_SAMPLER  Interactive figure: hit-and-run sampling of a 2D convex region.
%   HITANDRUN_SAMPLER(N) generates a random convex polygon, draws N samples
%   from the uniform distribution on it using the hit-and-run algorithm, and
%   opens a figure that shows the region and the samples.
%
%   This holds all the wiring: it builds the region, runs the sampler, loads
%   the prebuilt figure app, and sends region + samples to it (script ->
%   figure). It also re-samples on request (figure -> script) so the controls
%   in the figure drive the algorithm.
%
%   The region/sampling algorithm lives in helpers/ (make_region, hit_and_run);
%   the end-user script (hitandrun_demo.m) puts that folder on the path with
%   `addpath('helpers')` and calls this. Run hitandrun_demo.m, not this file
%   directly, so the path is set up.
%
%   The script is a stateless sampling service: the figure owns the current
%   region and sends it back with each resample request, so there is no
%   server-side state to keep in sync across callbacks.

if nargin < 1 || isempty(N)
    N = 10000;
end

% Build a region (convex by default) and draw N uniform samples from it.
convex = true;
[vx, vy] = make_region(convex);
[sx, sy] = sample_region(vx, vy, N, convex, false);

% The figure app is the prebuilt single-file page, relative to the project root
% (the current working directory when a top-level script is run).
html = fileread(fullfile('app', 'dist', 'index.html'));

fig = figure;
gl = uigridlayout(fig, [1 1], 'Padding', [0 0 0 0], ...
                  'RowHeight', {'1x'}, 'ColumnWidth', {'1x'});
uihtml(gl, 'HTMLSource', html, 'Data', pack_data(vx, vy, sx, sy, N, convex), ...
       'HTMLEventReceivedFcn', @(src, ev) on_event(src, ev));
end

function on_event(src, ev)
% Figure -> script. Two requests the controls send (both carry the region type
% `convex` and, for non-convex regions, the `local` sampling mode):
%   'resample'  {n, x, y, convex, local}  -> draw n fresh samples in the given
%                                     region; reply with a 'samples' event.
%   'newRegion' {n, convex, local}   -> build a new region (convex or
%                                     non-convex), draw n samples; reply with a
%                                     'data' event.
d = ev.HTMLEventData;
n = 10000;
convex = true;
local = false;
if isstruct(d)
    if isfield(d, 'n')
        n = max(1, round(d.n));
    end
    if isfield(d, 'convex')
        convex = logical(d.convex);
    end
    if isfield(d, 'local')
        local = logical(d.local);
    end
end
switch ev.HTMLEventName
    case 'resample'
        vx = d.x(:);
        vy = d.y(:);
        [sx, sy] = sample_region(vx, vy, n, convex, local);
        sendEventToHTMLSource(src, 'samples', pack_samples(sx, sy, n));
    case 'newRegion'
        [vx, vy] = make_region(convex);
        [sx, sy] = sample_region(vx, vy, n, convex, local);
        sendEventToHTMLSource(src, 'data', pack_data(vx, vy, sx, sy, n, convex));
end
end

function [sx, sy] = sample_region(vx, vy, n, convex, local)
% Convex regions use the fast JIT-compiled chord sampler; non-convex regions
% use the general sampler, in union (default) or local-segment mode.
tic;
if convex
    [sx, sy] = hit_and_run(vx, vy, n, 50);
else
    [sx, sy] = hit_and_run_general(vx, vy, n, 50, local);
end
fprintf('sample_region: N=%d convex=%d local=%d in %.3f s\n', n, convex, local, toc);
end

function data = pack_data(vx, vy, sx, sy, N, convex)
%PACK_DATA  Full payload (region + samples) sent once when the figure opens.
data = struct();
data.type = 'hitandrun';
data.region = struct('x', vx(:).', 'y', vy(:).');
data.samples = struct('x', sx(:).', 'y', sy(:).');
data.n = N;
data.convex = convex;
end

function s = pack_samples(sx, sy, N)
%PACK_SAMPLES  Just the samples, sent on a resample (region is unchanged).
s = struct('x', sx(:).', 'y', sy(:).', 'n', N);
end
