import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { configureOxlintThreads } from "../bin/oxlint.mjs";

test("Oxlint thread options reach both backends, including the embedded patch", () => {
  const embedded = vm.runInNewContext(`(${configureOxlintThreads.toString()})`);
  for (const configure of [configureOxlintThreads, embedded]) {
    for (const args of [["--threads", "1"], ["--threads=1"], ["--threads=+1"]]) {
      const env = { RAYON_NUM_THREADS: "8", GOMAXPROCS: "8" };
      configure(args, env);
      assert.deepEqual(env, { EFFECT_TSRS_THREADS: "1", RAYON_NUM_THREADS: "1", GOMAXPROCS: "1" });
    }
    const parallel = {};
    configure(["--threads", "4"], parallel);
    assert.deepEqual(parallel, { EFFECT_TSRS_THREADS: "4", RAYON_NUM_THREADS: "4", GOMAXPROCS: "4" });
    for (const args of [[], ["--", "--threads=1"], ["--threads=0"], ["--threads"], ["--threads=invalid"], ["--threads=-1"]]) {
      const env = { GOMAXPROCS: "2" };
      configure(args, env);
      assert.deepEqual(env, { GOMAXPROCS: "2" });
    }
  }
});
