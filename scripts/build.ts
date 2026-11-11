import { $ } from "bun";

const targets = [
  ["bun-darwin-arm64", "beam-mac-arm64"],
  ["bun-darwin-x64-baseline", "beam-mac-x64"],
  ["bun-windows-x64-baseline", "beam-windows-x64.exe"],
] as const;

await $`rm -rf dist && mkdir -p dist`;
for (const [target, out] of targets) {
  console.log(`building ${out} (${target})`);
  await $`bun build ./src/cli.ts --compile --minify --target=${target} --outfile dist/${out}`.quiet();
}
await $`ls -lh dist`;
