// Manual verification of the Ren'Py manifest pipeline against a real game dir.
// Usage: node test/manifest-probe.mjs <gameDir> [--json]
import { buildManifest } from "../lib/manifest.js";
import { parseStatement, applyStatements, StageStore, StageError } from "../lib/stage.js";

const root = process.argv[2];
if (root === undefined) {
  console.error("usage: node test/manifest-probe.mjs <gameDir> [--json]");
  process.exit(2);
}
const asJson = process.argv.includes("--json");
const t0 = Date.now();
const { manifest } = buildManifest(root, {
  assetUrl: (p) => `http://127.0.0.1:1/renpy-skin/asset?p=${encodeURIComponent(p)}`,
});
const buildMs = Date.now() - t0;

if (asJson) {
  console.log(JSON.stringify(manifest, null, 2));
  process.exit(0);
}

console.log(`root          ${root}`);
console.log(`game name     ${manifest.game.name} v${manifest.game.version ?? "-"}`);
console.log(`screen        ${manifest.game.screen.w}x${manifest.game.screen.h}`);
console.log(`built in      ${buildMs} ms`);
console.log(`stats         ${JSON.stringify(manifest.stats)}`);
console.log(`accent        ${manifest.theme["--dsw-alias-brand-primary"].dark}`);
console.log(`dialogbox     h=${manifest.dialogbox.height} yalign=${manifest.dialogbox.yalign} fill=${manifest.dialogbox.fill} text=${manifest.dialogbox.textColor}`);
console.log(`choice        w=${manifest.choice.width} idle=${manifest.choice.textIdleColor} hover=${manifest.choice.textHoverColor}`);
console.log("");
console.log("backgrounds (first 8):");
for (const bg of manifest.backgrounds.slice(0, 8)) {
  console.log(`  ${bg.name.padEnd(34)} ${bg.width ?? "?"}x${bg.height ?? "?"}  ${bg.path}`);
}
console.log("");
console.log(`tags: ${manifest.tags.length}`);
for (const tag of manifest.tags.slice(0, 6)) {
  console.log(`  ${tag.tag}: ${tag.expressions.slice(0, 6).map((e) => e.label).join(" / ")}  (${tag.expressions.length})`);
}
console.log("");
console.log(`transforms: ${Object.keys(manifest.transforms).length}`);

// ---- stage parser probes -------------------------------------------------
const stage = new StageStore().get("probe");
const bg = manifest.backgrounds[0]?.name;
const tag = manifest.tags[0];
const expr = tag?.expressions[0]?.label;

const cases = [
  `scene ${bg} with fade`,
  `show ${tag?.tag} ${expr} at center`,
  `show ${tag?.tag} ${expr} at left, Transform(zoom=0.9)`,
  `show ${tag?.tag} ${expr} at center zorder 5`,
  `hide ${tag?.tag}`,
  `show definitely_not_a_tag happy`,
  `show ${tag?.tag} ${expr} at nosuchtransform`,
  `scene ${bg} with wipeleft`,
  `frobnicate something`,
];

console.log("\nstage probes:");
for (const line of cases) {
  try {
    const statement = parseStatement(line);
    const outcome = applyStatements(stage, [statement], manifest, {});
    console.log(`  OK   ${line}`);
    if (outcome.warnings.length > 0) console.log(`       warn: ${outcome.warnings.join("; ")}`);
  } catch (error) {
    if (error instanceof StageError) {
      const detail = Object.keys(error.details).length > 0 ? ` ${JSON.stringify(error.details).slice(0, 160)}` : "";
      console.log(`  FAIL ${line}\n       ${error.message}${detail}`);
    } else {
      throw error;
    }
  }
}
console.log("\nfinal stage:", JSON.stringify({
  scene: stage.scene?.image,
  sprites: stage.sprites.map((s) => ({ tag: s.tag, image: s.image, xpos: s.xpos, zorder: s.zorder })),
}));
