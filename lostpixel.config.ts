import type { CustomProjectConfig } from "lost-pixel";

// Lost Pixel (OSS mode): visual regression over the Storybook catalog. It builds one
// screenshot per story from the static build, and compares each against a committed
// baseline PNG under .lostpixel/baseline. A pixel change fails CI and writes a diff
// image; to accept an intended change you regenerate the baselines (`bun run
// visual:update`) and commit them — so the PR's baseline diff *is* the record of what
// changed on screen.
//
// Rendering must be deterministic or fonts/antialiasing produce false diffs, so both
// the baselines and the CI run are produced by the SAME pinned Docker image
// (lostpixel/lost-pixel, matched to this package's lost-pixel version). See
// .github/workflows/visual.yml and the scripts in package.json.
export const config: CustomProjectConfig = {
  storybookShots: {
    storybookUrl: "./storybook-static",
  },
  imagePathBaseline: "./.lostpixel/baseline",
  imagePathCurrent: "./.lostpixel/current",
  imagePathDifference: "./.lostpixel/difference",
  failOnDifference: true,
};
