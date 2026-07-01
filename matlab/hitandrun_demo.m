% Hit-and-run MCMC sampling of a 2D convex region.
%
% A random convex polygon is generated, then N points are drawn from the
% uniform distribution on it with the hit-and-run algorithm: from the current
% point, pick a random direction, find the chord where that line crosses the
% region, and jump to a uniform-random point on the chord. Repeat. The figure
% shows the region outline and the resulting samples.
%
% The region + sampling functions live in helpers/. `addpath` must be the
% first statement (numbl resolves the driver's search path before running),
% so it comes before everything else.

addpath('helpers');     % make_region, hit_and_run

rng(1);                 % reproducible region + samples

hitandrun_sampler(10000);   % matches the figure's default samples control
