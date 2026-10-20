/**
 * Manual probe: read every real `.rpa` archive we can find and print what the
 * reader made of it. Not part of `node --test` because it depends on games
 * installed on this machine; `test/skin.test.mjs` covers the reader with
 * archives it writes itself.
 *
 *   node test/rpa-probe.mjs [extraDir ...]
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { openRpa } from "../lib/rpa3.js";

const DEFAULT_DIRS = [
  "D:/Games/Castle&Myosotis-1.2.6-pc/game",
  "D:/Games/SharedHouse-3.12-beta-pc/game",
  "D:/Games/Tavern_of_Spear-0.37f-pc/Tavern_of_Spear-0.37.6-pc/game",
  "D:/Games/GoToSnowTown-0.3.0-pc/game",
  "D:/Games/GoToSnowTown-0.3.5-pc/GoToSnowTown-0.3.5-pc/game",
  "D:/Games/Arches-1.0-win/game",
  "D:/Games/Adastra-17-win/game",
];

const dirs = [...process.argv.slice(2), ...DEFAULT_DIRS];
let ok = 0;
let bad = 0;

for (const dir of dirs) {
  if (!existsSync(dir)) continue;
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".rpa"))) {
    const path = `${dir}/${file}`;
    const mb = (statSync(path).size / 1048576).toFixed(1);
    try {
      const archive = openRpa(path);
      const scripts = archive.names.filter((name) => typeof name === "string" && name.endsWith(".rpy"));
      const sample = scripts[0] ?? archive.names[0];
      if (sample === undefined) throw new Error(`index parsed but yielded no names (scripts=${scripts.length})`);
      const bytes = archive.read(sample);
      const firstLine = bytes.toString("utf8").split("\n")[0]?.slice(0, 56) ?? "";
      console.log(
        `OK   ${file.padEnd(13)} ${String(mb).padStart(7)}MB  entries=${String(archive.names.length).padStart(6)}  rpy=${String(scripts.length).padStart(4)}  ` +
          `${sample} (${bytes.length}B) ${JSON.stringify(firstLine)}`,
      );
      ok += 1;
    } catch (error) {
      console.log(`FAIL ${file.padEnd(13)} ${String(mb).padStart(7)}MB  ${error.constructor.name}: ${error.message}`);
      bad += 1;
    }
  }
}

console.log(`\n${ok} archive(s) read, ${bad} failed.`);
