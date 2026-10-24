# Effect Diagnostics (tsrs)

A Rust port of the [Effect Language Service diagnostics](https://github.com/Effect-TS/tsgo),
powered by [tsrs](https://github.com/oxc-project/tsrs). Provides all **130 diagnostic
rules** for **Effect V4** and **Effect V3**.

The port provides a command-line diagnostic runner and Oxlint type-aware linting.
Effect quick fixes, refactors, and completions are available in the upstream
[`@effect/tsgo` language service](https://github.com/Effect-TS/tsgo).

## Installation

Add `@yielded/effect-tsrs` to your project:

```sh
npm install --save-dev @yielded/effect-tsrs
```

Then check your project:

```sh
npx effect-tsrs diagnostics --project tsconfig.json
```

Or run it without adding a dependency:

```sh
npx @yielded/effect-tsrs diagnostics --project tsconfig.json
```

Requires **Node.js 22.14 or newer**. Prebuilt binaries are available for macOS
(Apple Silicon and Intel), Linux (ARM64 and x64), and Windows (x64). The compiler
and TypeScript standard libraries are included; no Rust toolchain is needed.

Keep npm optional dependencies enabled so the binary for your platform is installed.
Existing `@effect/language-service` plugin options in `tsconfig.json` are respected.
See [Plugin Options](#plugin-options) to configure diagnostics.

## Oxlint integration

Install a supported Oxlint pair, then run it through the Rust adapter:

```sh
npm install --save-dev oxlint@1.89.0 oxlint-tsgolint@7.0.2005
npx effect-tsrs oxlint .
```

Enable Effect rules in `.oxlintrc.json`. The `effecttsgo` namespace is retained for
compatibility with existing configurations:

```json
{
  "$schema": "./node_modules/@yielded/effect-tsrs/oxlint-schema.json",
  "plugins": ["effecttsgo", "typescript"],
  "rules": {
    "effecttsgo/floating-effect": "error",
    "effecttsgo/missing-star-in-yield-effect-gen": "error",
    "typescript/no-floating-promises": "error"
  }
}
```

The adapter enables `--type-aware` automatically. Oxlint owns severities,
per-file overrides, ignore patterns, and suppression comments. All 130 Effect
rules run in Rust; other type-aware rules and `--type-check` use the installed
`oxlint-tsgolint` backend. Effect behavior options and source
directives remain supported; Oxlint rule selection overrides tsconfig diagnostic
severities. Effect code actions (quick fixes and suggested edits) and per-rule
profiling are not ported.

`--threads N` limits the compiler workers as well as Oxlint's frontend. Under an
explicit limit the Rust and Go backend passes run sequentially; `--threads 1`
also disables parallel parsing and checking. Without a limit, tsrs chooses its
checker count and the backends can run concurrently. The standalone diagnostics
command accepts `--singleThreaded` for single-threaded comparisons.

Presets are available as `@yielded/effect-tsrs/oxlint-presets` for JS/TS configs,
or through `extends`, for example:
`["./node_modules/@yielded/effect-tsrs/oxlint-presets/recommended.json"]`.

For existing scripts or editor integrations that invoke Oxlint directly, run
`npx effect-tsrs patch --oxlint`, then use `oxlint --type-aware` normally.
`npx effect-tsrs unpatch --oxlint` restores the original package bytes. Reapply
after reinstalling dependencies. Patching refuses shared symlink targets outside
the project; `effect-tsrs oxlint` works without modifying installed packages.

Supported Oxlint and oxlint-tsgolint versions, along with the packaged frontend
source, are pinned in [the Oxlint metadata](bin/oxlint-metadata.json). The Effect
backend is this Rust port. Linux Oxlint integration requires glibc; the standalone
diagnostic CLI also works with musl.

From a source checkout, run `npm run build:release && npm run prepare:oxlint`,
then `EFFECT_TSRS_BINARY="$PWD/target/release/effect-tsrs" node bin/effect-tsrs.js oxlint .`.
Run `npm run verify:oxlint` for integration checks against Effect TSGO.
`npm run verify:oxlint:all` compares all 614 fixture projects through the headless
protocol, covering all 130 rules, including duplicate diagnostics and related ranges.

## Standalone type-aware linter

The CLI reports Effect diagnostics using the defaults and project selection of
the [supported `@effect/tsgo` version](#supported-package-versions). It targets
configured root files and roots of referenced projects; imported files outside
those roots supply types but receive no Effect diagnostics. Shared roots use
the selected project's plugin configuration. See
[project selection](PORTING.md#project-selection) for reference loading,
overlap precedence, and file eligibility. Add it to your project scripts to run
the same check locally and in CI:

```json
{
  "scripts": {
    "check": "effect-tsrs diagnostics --project tsconfig.json"
  }
}
```

Diagnostics can also be emitted as JSON for other tools:

```sh
npx effect-tsrs diagnostics --project tsconfig.json --format json
```

The exit status reflects Effect errors (and warnings with `--strict`). Add
`--type-check` to also report ordinary TypeScript diagnostics and include them in
the exit status. This explicitly enables the combined check used by earlier
effect-tsrs versions.

JSON contains separate `diagnostics` and `typescriptDiagnostics` arrays,
[summary counts](PORTING.md#project-selection), and timings.
`typescriptDiagnostics` is populated by `--type-check`. The command
exits with **0** when there are no errors, **1** for project or diagnostic errors,
and **2** for invalid arguments. Warnings and suggestions do not fail the command
by default.

Use `--strict` to also exit with **1** when warnings are reported, matching
`effect-tsgo diagnostics --strict`:

```sh
npx effect-tsrs diagnostics --project tsconfig.json --strict
```

This only changes the exit code; warnings keep their severity in text and JSON
output. Suggestions still do not fail the command.

## Supported Package Versions

The current release is built and tested with the following versions:

| Component | Version |
| --- | --- |
| Effect | V3 (`3.19.19`) and V4 (`4.0.2`) |
| TypeScript | `7.1.0-beta`, bundled through tsrs |
| tsrs | `0.19.0`, pinned in [upstream.json](upstream.json) |
| Effect diagnostic rules | `@effect/tsgo@0.56.1` |
| Node.js | `>=22.14` |

## Diagnostic Status

All **130 rules** below are implemented. The release passes **4,263/4,263**
comparisons against upstream, including diagnostic messages, severities, ranges,
and related information. [Verification details](fixtures/all/verification.json).

Some rules are disabled by default or produce suggestions. Enable them or change
their severity in [Plugin Options](#plugin-options). Rule descriptions and links
below mirror the upstream README.

<!-- diagnostics-table:start -->
<table>
  <thead>
    <tr><th>Rule</th><th>Description</th></tr>
  </thead>
  <tbody>
    <tr><td colspan="2"><strong>Correctness</strong> <em>Wrong, unsafe, or structurally invalid code patterns.</em></td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/any-unknown-in-error-context.md"><code>anyUnknownInErrorContext</code></a></td><td>Detects &#39;any&#39; or &#39;unknown&#39; types in Effect error or requirements channels</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/class-self-mismatch.md"><code>classSelfMismatch</code></a></td><td>Ensures Self type parameter matches the class name in Context/Service/Tag/Schema classes</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/duplicate-package.md"><code>duplicatePackage</code></a></td><td>Warns when multiple versions of an Effect-related package are detected in the program</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-fn-implicit-any.md"><code>effectFnImplicitAny</code></a></td><td>Mirrors noImplicitAny for unannotated Effect.fn, Effect.fnUntraced, and Effect.fnUntracedEager callback parameters when no outer contextual function type exists. Requires TS&#39;s noImplicitAny: true</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/error-payload-shadows-name.md"><code>errorPayloadShadowsName</code></a></td><td>Detects error payload fields named `name` that shadow the error&#39;s own name</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/experimental-api-usage.md"><code>experimentalApiUsage</code></a></td><td>Warns when using an API marked @stability experimental</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/floating-effect.md"><code>floatingEffect</code></a></td><td>Detects Effect values that are neither yielded nor assigned</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/floating-effect-in-vitest.md"><code>floatingEffectInVitest</code></a></td><td>Detects Effects returned from non-Effect-aware Vitest callbacks</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/generic-effect-services.md"><code>genericEffectServices</code></a></td><td>Prevents services with type parameters that cannot be discriminated at runtime</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-effect-context.md"><code>missingEffectContext</code></a></td><td>Detects Effect values with unhandled context requirements</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-effect-error.md"><code>missingEffectError</code></a></td><td>Detects Effect values with unhandled error types</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-layer-context.md"><code>missingLayerContext</code></a></td><td>Detects Layer values with unhandled context requirements</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-return-yield-star.md"><code>missingReturnYieldStar</code></a></td><td>Suggests using return yield* for Effects that never succeed</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-star-in-yield-effect-gen.md"><code>missingStarInYieldEffectGen</code></a></td><td>Detects bare yield (without *) inside Effect generator scopes</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/non-object-effect-service-type.md"><code>nonObjectEffectServiceType</code></a></td><td>Ensures Effect.Service types are objects, not primitives</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/obsolete-match-import.md"><code>obsoleteMatchImport</code></a></td><td>Warns when importing @effect/match in projects targeting Effect v4, where Match is included directly in the effect package</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/obsolete-schema-import.md"><code>obsoleteSchemaImport</code></a></td><td>Warns when importing @effect/schema in projects targeting Effect v4, where Schema is included directly in the effect package</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/outdated-api.md"><code>outdatedApi</code></a></td><td>Detects usage of APIs that have been removed or renamed in Effect v4</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/overridden-schema-constructor.md"><code>overriddenSchemaConstructor</code></a></td><td>Prevents overriding constructors in Schema classes which breaks decoding behavior</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/promise-in-effect-success.md"><code>promiseInEffectSuccess</code></a></td><td>Detects Promise types in Effect success channels where they are not awaited</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-class-missing-brand.md"><code>schemaClassMissingBrand</code></a></td><td>Warns when Schema classes, errors, or Opaque classes omit the brand type argument</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-class-object-literal.md"><code>schemaClassObjectLiteral</code></a></td><td>Warns when object literals are checked as Schema class instances without the class prototype</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-literal-non-finite.md"><code>schemaLiteralNonFinite</code></a></td><td>Reports statically known non-finite numbers passed to Schema literal constructors</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-opaque-instance-member.md"><code>schemaOpaqueInstanceMember</code></a></td><td>Disallows instance members in classes extending Schema.Opaque</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unsafe-effect-type-assertion.md"><code>unsafeEffectTypeAssertion</code></a></td><td>Detects unsafe type assertions that narrow Effect, Stream, or Layer error or requirements channels</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unstable-api-usage.md"><code>unstableApiUsage</code></a></td><td>Warns when using an API marked @stability unstable</td></tr>
    <tr><td colspan="2"><strong>Anti-pattern</strong> <em>Discouraged patterns that often lead to bugs or confusing behavior.</em></td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-unfailable-effect.md"><code>catchUnfailableEffect</code></a></td><td>Warns when using error handling on Effects that never fail</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-fn-iife.md"><code>effectFnIife</code></a></td><td>Effect.fn or Effect.fnUntraced is called as an IIFE; use Effect.gen instead</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-gen-uses-adapter.md"><code>effectGenUsesAdapter</code></a></td><td>Warns when using the deprecated adapter parameter in Effect.gen</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-in-failure.md"><code>effectInFailure</code></a></td><td>Warns when an Effect is used inside an Effect failure channel</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-in-void-success.md"><code>effectInVoidSuccess</code></a></td><td>Detects nested Effects in void success channels that may cause unexecuted effects</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-error-in-effect-catch.md"><code>globalErrorInEffectCatch</code></a></td><td>Warns when catch callbacks return global Error type instead of typed errors</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-error-in-effect-failure.md"><code>globalErrorInEffectFailure</code></a></td><td>Warns when the global Error type is used in an Effect failure channel</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/layer-merge-all-with-dependencies.md"><code>layerMergeAllWithDependencies</code></a></td><td>Detects interdependencies in Layer.mergeAll calls where one layer provides a service that another layer requires</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/lazy-effect.md"><code>lazyEffect</code></a></td><td>Suggests avoiding exported zero-argument functions and service members that lazily return Effect or Stream values</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/lazy-promise-in-effect-sync.md"><code>lazyPromiseInEffectSync</code></a></td><td>Warns when Effect.sync lazily returns a Promise instead of using an async Effect constructor</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/leaking-requirements.md"><code>leakingRequirements</code></a></td><td>Detects implementation services leaked in service methods</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/multiple-effect-provide.md"><code>multipleEffectProvide</code></a></td><td>Warns against chaining Effect.provide calls which can cause service lifecycle issues</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-unsafe-constructor.md"><code>preferUnsafeConstructor</code></a></td><td>Suggests replacing Effect.runSync of a pure effect constructor with the synchronous *Unsafe variant exported by the same module</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/return-effect-in-gen.md"><code>returnEffectInGen</code></a></td><td>Warns when returning an Effect in a generator causes nested Effect&lt;Effect&lt;...&gt;&gt;</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/run-effect-inside-effect.md"><code>runEffectInsideEffect</code></a></td><td>Suggests using Runtime or Effect.run*With methods instead of Effect.run* inside Effect contexts</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-sync-in-effect.md"><code>schemaSyncInEffect</code></a></td><td>Suggests using Effect-based Schema methods instead of sync methods inside Effect generators</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/scope-in-layer-effect.md"><code>scopeInLayerEffect</code></a></td><td>Suggests using Layer.scoped instead of Layer.effect when Scope is in requirements</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/strict-effect-provide.md"><code>strictEffectProvide</code></a></td><td>Warns when using Effect.provide with layers outside of application entry points</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/try-catch-in-effect-gen.md"><code>tryCatchInEffectGen</code></a></td><td>Discourages try/catch in Effect generators in favor of Effect error handling</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unknown-in-effect-catch.md"><code>unknownInEffectCatch</code></a></td><td>Warns when catch callbacks return unknown instead of typed errors</td></tr>
    <tr><td colspan="2"><strong>Effect-native</strong> <em>Prefer Effect-native APIs and abstractions when available.</em></td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/abort-controller-in-effect.md"><code>abortControllerInEffect</code></a></td><td>Warns when manually constructing AbortController inside Effect generators instead of using Effect.abortSignal</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/async-function.md"><code>asyncFunction</code></a></td><td>Warns when declaring async functions and suggests using Effect values and Effect.gen for async control flow</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/crypto-random-uuid.md"><code>cryptoRandomUUID</code></a></td><td>Warns when using crypto.randomUUID() outside Effect generators instead of the Effect Crypto module</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/crypto-random-uuid-in-effect.md"><code>cryptoRandomUUIDInEffect</code></a></td><td>Warns when using crypto.randomUUID() inside Effect generators instead of the Effect Crypto module</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/extends-native-error.md"><code>extendsNativeError</code></a></td><td>Warns when a class directly extends the native Error class</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-console.md"><code>globalConsole</code></a></td><td>Warns when using console methods outside Effect generators instead of Effect.log/Logger</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-console-in-effect.md"><code>globalConsoleInEffect</code></a></td><td>Warns when using console methods inside Effect generators instead of Effect.log/Logger</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-date.md"><code>globalDate</code></a></td><td>Warns when using Date.now() or new Date() outside Effect generators instead of Clock/DateTime</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-date-in-effect.md"><code>globalDateInEffect</code></a></td><td>Warns when using Date.now() or new Date() inside Effect generators instead of Clock/DateTime</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-fetch.md"><code>globalFetch</code></a></td><td>Warns when using the global fetch function outside Effect generators instead of the Effect HTTP client</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-fetch-in-effect.md"><code>globalFetchInEffect</code></a></td><td>Warns when using the global fetch function inside Effect generators instead of the Effect HTTP client</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-random.md"><code>globalRandom</code></a></td><td>Warns when using Math.random() outside Effect generators instead of the Random service</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-random-in-effect.md"><code>globalRandomInEffect</code></a></td><td>Warns when using Math.random() inside Effect generators instead of the Random service</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-timers.md"><code>globalTimers</code></a></td><td>Warns when using setTimeout/setInterval outside Effect generators instead of Effect.sleep/Schedule</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/global-timers-in-effect.md"><code>globalTimersInEffect</code></a></td><td>Warns when using setTimeout/setInterval inside Effect generators instead of Effect.sleep/Schedule</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/instance-of-schema.md"><code>instanceOfSchema</code></a></td><td>Suggests using Schema.is instead of instanceof for Effect Schema types</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/new-promise.md"><code>newPromise</code></a></td><td>Warns when constructing promises with new Promise instead of using Effect APIs</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/node-builtin-import.md"><code>nodeBuiltinImport</code></a></td><td>Warns when importing Node.js built-in modules that have Effect-native counterparts</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-effect-array.md"><code>preferEffectArray</code></a></td><td>Suggests Effect Array APIs for native array member references, with semantic caveats</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-effect-record.md"><code>preferEffectRecord</code></a></td><td>Suggests Effect Record APIs for native Object member references, with semantic caveats</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-effect-string.md"><code>preferEffectString</code></a></td><td>Suggests Effect String APIs for native String method invocations, with semantic caveats</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-schema-over-json.md"><code>preferSchemaOverJson</code></a></td><td>Suggests using Effect Schema for JSON operations instead of JSON.parse/JSON.stringify</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/process-env.md"><code>processEnv</code></a></td><td>Warns when reading process.env outside Effect generators instead of using Effect Config</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/process-env-in-effect.md"><code>processEnvInEffect</code></a></td><td>Warns when reading process.env inside Effect generators instead of using Effect Config</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-sync.md"><code>schemaSync</code></a></td><td>Suggests Effect-based Schema decoding and encoding instead of synchronous methods</td></tr>
    <tr><td colspan="2"><strong>Style</strong> <em>Cleanup, consistency, and idiomatic Effect code.</em></td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/acquire-release-disposable.md"><code>acquireReleaseDisposable</code></a></td><td>Suggests Effect.acquireDisposable when Effect.acquireRelease only invokes the acquired resource&#39;s disposal protocol</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/all-of-map-to-for-each.md"><code>allOfMapToForEach</code></a></td><td>Suggests using Effect.forEach instead of Effect.all over an effectful Array#map</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-all-tag-dispatch-to-catch-tag.md"><code>catchAllTagDispatchToCatchTag</code></a></td><td>Suggests Effect.catchTag or Effect.catchTags for catch-all handlers that re-fail unmatched tagged errors</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-all-to-map-error.md"><code>catchAllToMapError</code></a></td><td>Suggests using Effect.mapError instead of Effect.catch + Effect.fail</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-chain-to-first-success-of.md"><code>catchChainToFirstSuccessOf</code></a></td><td>Suggests Effect.firstSuccessOf for consecutive error-independent Effect.catch fallbacks when the error type is preserved</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-conditional-refail-to-catch-if.md"><code>catchConditionalRefailToCatchIf</code></a></td><td>Suggests Effect.catchIf, Effect.catchCauseIf, or Effect.catchTag for conditional catch handlers that re-fail their untouched input</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-die-to-or-die.md"><code>catchDieToOrDie</code></a></td><td>Suggests using Effect.orDie instead of Effect.catch or Effect.catchAll with an identity-forwarding Effect.die handler</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-if-tag-to-catch-tag.md"><code>catchIfTagToCatchTag</code></a></td><td>Suggests Effect.catchTag instead of Effect.catchIf with a _tag equality or Predicate.isTagged predicate</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-refail-to-tap-error.md"><code>catchRefailToTapError</code></a></td><td>Suggests Effect.tapError for catch handlers that sequence an effect and then re-fail the original error</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-tag-to-catch-reason.md"><code>catchTagToCatchReason</code></a></td><td>Suggests Effect.catchReason or Effect.catchReasons for handlers that re-fail unmatched reason._tag branches</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-to-ignore.md"><code>catchToIgnore</code></a></td><td>Suggests using Effect.ignore or Effect.ignoreCause instead of Effect.catch/catchCause returning Effect.void</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/catch-to-or-else-succeed.md"><code>catchToOrElseSucceed</code></a></td><td>Suggests using Effect.orElseSucceed instead of Effect.catch + Effect.succeed</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/deterministic-keys.md"><code>deterministicKeys</code></a></td><td>Enforces deterministic naming for service/tag/error identifiers based on class names</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-do-notation.md"><code>effectDoNotation</code></a></td><td>Suggests using Effect.gen or Effect.fn instead of the Effect.Do notation helpers</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-fn-opportunity.md"><code>effectFnOpportunity</code></a></td><td>Suggests using Effect.fn for functions that return an Effect</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-map-flatten.md"><code>effectMapFlatten</code></a></td><td>Suggests using Effect.flatMap instead of Effect.map followed by Effect.flatten in piping flows</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-map-void.md"><code>effectMapVoid</code></a></td><td>Suggests using Effect.asVoid instead of Effect.map(() =&gt; void 0), Effect.map(() =&gt; undefined), or Effect.map(() =&gt; {})</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-sleep-zero-to-yield-now.md"><code>effectSleepZeroToYieldNow</code></a></td><td>Suggests Effect.yieldNow for cooperative yielding instead of sleeping for zero duration</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/effect-succeed-with-void.md"><code>effectSucceedWithVoid</code></a></td><td>Suggests using Effect.void instead of Effect.succeed(undefined) or Effect.succeed(void 0)</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/flat-map-conditional-to-filter-or-fail.md"><code>flatMapConditionalToFilterOrFail</code></a></td><td>Suggests Effect.filterOrFail or Effect.filterOrElse when Effect.flatMap conditionally passes its input through with Effect.succeed</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/flat-map-ignored-param-to-and-then.md"><code>flatMapIgnoredParamToAndThen</code></a></td><td>Suggests using Effect.andThen instead of Effect.flatMap when a zero-parameter callback returns an existing Effect value</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/flat-map-to-map.md"><code>flatMapToMap</code></a></td><td>Suggests using Effect.map instead of Effect.flatMap when the callback only wraps its result with Effect.succeed</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/flat-map-to-tap.md"><code>flatMapToTap</code></a></td><td>Suggests Effect.tap when a flatMap or andThen callback runs an effect and returns its unchanged parameter</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/map-some-to-as-some.md"><code>mapSomeToAsSome</code></a></td><td>Suggests using Effect.asSome instead of Effect.map when the mapper only wraps the success value with Option.some</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/match-effect-to-map-both.md"><code>matchEffectToMapBoth</code></a></td><td>Suggests Effect.mapBoth when Effect.matchEffect only transforms the failure and success channels</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/match-effect-to-match.md"><code>matchEffectToMatch</code></a></td><td>Suggests Effect.match or Effect.matchCause when both Effect.matchEffect handlers only return Effect.succeed</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missed-pipeable-opportunity.md"><code>missedPipeableOpportunity</code></a></td><td>Suggests using .pipe() for nested function calls</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-effect-service-dependency.md"><code>missingEffectServiceDependency</code></a></td><td>Checks that Effect.Service dependencies satisfy all required layer inputs</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/missing-pipeable-signature.md"><code>missingPipeableSignature</code></a></td><td>Reports exported fixed-arity functions whose call signatures have no corresponding pipeable overload</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/multiple-catch-tag.md"><code>multipleCatchTag</code></a></td><td>Suggests collapsing consecutive Effect.catchTag transformations into a single Effect.catchTags call when semantics stay equivalent</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/nested-effect-gen-yield.md"><code>nestedEffectGenYield</code></a></td><td>Warns when yielding a nested bare Effect.gen inside an existing Effect generator context</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/new-schema-class.md"><code>newSchemaClass</code></a></td><td>Suggests using Schema make instead of new for Schema classes</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/option-match-to-from-option.md"><code>optionMatchToFromOption</code></a></td><td>Suggests Effect.fromOption when Option.match or an Option tag conditional only converts Some to Effect.succeed and None to Effect.fail</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-barrel-import.md"><code>preferBarrelImport</code></a></td><td>Reports imports of individual modules from packages configured in barrelImportPackages that should be named imports from the package barrel</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-namespace-import.md"><code>preferNamespaceImport</code></a></td><td>Reports named imports from packages configured in namespaceImportPackages that should be namespace imports</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-schema-tagged-error.md"><code>preferSchemaTaggedError</code></a></td><td>Suggests using Schema.TaggedError instead of Data.TaggedError</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-schema-type-property.md"><code>preferSchemaTypeProperty</code></a></td><td>Disallows Schema.Schema.Type&lt;typeof X&gt; in favor of typeof X.Type</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-succeed-some-or-none.md"><code>preferSucceedSomeOrNone</code></a></td><td>Suggests using Effect.succeedNone or Effect.succeedSome instead of wrapping Option.none or Option.some with Effect.succeed</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/prefer-typed-schema-decoder.md"><code>preferTypedSchemaDecoder</code></a></td><td>Suggests typed Schema decoders when the input is assignable to the schema&#39;s Encoded type</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/provide-layer-succeed-to-provide-service.md"><code>provideLayerSucceedToProvideService</code></a></td><td>Suggests providing inline Layer.succeed and Layer.effect services directly</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/race-first-with-sleep-to-timeout.md"><code>raceFirstWithSleepToTimeout</code></a></td><td>Suggests Effect.timeoutOrElse when Effect.raceFirst has exactly one sleep- or delay-based timer arm</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/redundant-map-error.md"><code>redundantMapError</code></a></td><td>Suggests hoisting a repeated trailing Effect.mapError from every yield in an Effect generator</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/redundant-or-die.md"><code>redundantOrDie</code></a></td><td>Suggests hoisting a repeated trailing Effect.orDie from every yield in an Effect generator</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/redundant-schema-tag-identifier.md"><code>redundantSchemaTagIdentifier</code></a></td><td>Suggests removing redundant identifier argument when it equals the tag value in Schema.TaggedClass/TaggedError/TaggedRequest</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/run-of-exit-to-run-exit.md"><code>runOfExitToRunExit</code></a></td><td>Suggests using Effect.runPromiseExit instead of passing Effect.exit to Effect.runPromise</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-number.md"><code>schemaNumber</code></a></td><td>Suggests Schema.Finite and Schema.FiniteFromString instead of Schema.Number APIs when describing domain numbers</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-struct-with-tag.md"><code>schemaStructWithTag</code></a></td><td>Suggests using Schema.TaggedStruct instead of Schema.Struct with _tag field</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/schema-union-of-literals.md"><code>schemaUnionOfLiterals</code></a></td><td>Suggests combining multiple Schema.Literal calls in Schema.Union into a single Schema.Literal</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/service-not-as-class.md"><code>serviceNotAsClass</code></a></td><td>Warns when Context.Service is used as a variable instead of a class declaration</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/strict-boolean-expressions.md"><code>strictBooleanExpressions</code></a></td><td>Enforces boolean types in conditional expressions for type safety</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/sync-to-succeed.md"><code>syncToSucceed</code></a></td><td>Suggests using Effect.succeed instead of Effect.sync when the thunk returns a constant value</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/timeout-catch-tag-to-timeout-or-else.md"><code>timeoutCatchTagToTimeoutOrElse</code></a></td><td>Suggests dedicated timeout combinators instead of catching TimeoutError immediately after Effect.timeout</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-arrow-block.md"><code>unnecessaryArrowBlock</code></a></td><td>Suggests using a concise arrow body when the block only returns an expression</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-effect-gen.md"><code>unnecessaryEffectGen</code></a></td><td>Suggests removing Effect.gen when it contains only a single return statement</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-fail-yieldable-error.md"><code>unnecessaryFailYieldableError</code></a></td><td>Suggests yielding yieldable errors directly instead of wrapping with Effect.fail</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-pipe.md"><code>unnecessaryPipe</code></a></td><td>Removes pipe calls with no arguments</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-pipe-chain.md"><code>unnecessaryPipeChain</code></a></td><td>Simplifies chained pipe calls into a single pipe call</td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/unnecessary-typeof-type.md"><code>unnecessaryTypeofType</code></a></td><td>Suggests replacing typeof Schema.Type style annotations with the matching named type when available</td></tr>
    <tr><td colspan="2"><strong>Maintainers</strong> <em>Guard the public API surface and release hygiene of a package.</em></td></tr>
    <tr><td><a href="https://github.com/Effect-TS/tsgo/blob/main/docs/rules/api-stability-leak.md"><code>apiStabilityLeak</code></a></td><td>Reports exported APIs whose public surface exposes a less stable type</td></tr>
  </tbody>
</table>
<!-- diagnostics-table:end -->

## Refactor Status

Refactors and quick fixes are not implemented in this port. Use
[`@effect/tsgo`](https://github.com/Effect-TS/tsgo#refactor-status) for editor code actions.

### Completion Status

Editor completions are not implemented in this port. See the upstream
[completion status](https://github.com/Effect-TS/tsgo#completion-status).

## Best Practices

### Relationship to effect-tsgo and tsrs

Use `effect-tsrs` for project diagnostics in your terminal, scripts, and CI.
It runs the Effect rules on tsrs's inferred types and symbols.

`@effect/tsgo` provides the full editor language service, including quick fixes,
refactors, and completions. `effect-tsrs` is a standalone diagnostics CLI and
does not replace your editor's TypeScript language server or build command.

### Version Pinning

Each release bundles a pinned tsrs compiler and its TypeScript standard libraries.
[upstream.json](upstream.json) records the compiler revision; see
[Supported Package Versions](#supported-package-versions) for the Effect diagnostic
baseline. Updating a separate TypeScript installation does not change the compiler
used by `effect-tsrs`.

### When to Upgrade

Upgrade `@yielded/effect-tsrs` when a release includes compiler fixes or Effect
diagnostics you need. npm installs the matching native package for your platform.

## Plugin Options

Configure diagnostics in your existing `tsconfig.json` using the same
`@effect/language-service` plugin entry as upstream. By default, the CLI skips
Effect diagnostics for a project without a plugin entry. Pass `--lspconfig '{}'` to
explicitly activate upstream defaults without editing the project config.

```jsonc
{
  "compilerOptions": {
    "plugins": [
      {
        "name": "@effect/language-service",
        // Enable Effect diagnostics. (default: true)
        "diagnostics": true,
        // Upstream tsc option; standalone diagnostics always includes suggestions.
        "includeSuggestionsInTsc": true,
        // Process disabled rules so source directives can re-enable them.
        "skipDisabledOptimization": false,
        // Prefer namespace or barrel imports for these packages.
        "namespaceImportPackages": [],
        "barrelImportPackages": [],
        // Follow named reexports at package top level. (default: "ignore")
        "topLevelNamedReexports": "ignore",
        // Patterns used by deterministicKeys.
        "keyPatterns": [
          { "target": "service", "pattern": "default", "skipLeadingPath": ["src/"] },
          { "target": "custom", "pattern": "default", "skipLeadingPath": ["src/"] }
        ],
        "extendedKeyDetection": false,
        // Minimum pipeable transformations for missedPipeableOpportunity.
        "pipeableMinArgCount": 2,
        // Permit selected unstable or experimental APIs.
        "allowedUnstableApis": [],
        "allowedExperimentalApis": [],
        // Permit multiple versions of these packages.
        "allowedDuplicatedPackages": [],
        // Variants considered by effectFnOpportunity.
        "effectFn": ["span"],
        // Override rule defaults. Use {} to keep the defaults.
        "diagnosticSeverity": {
          "floatingEffect": "error",
          "asyncFunction": "warning"
        },
        // Apply options to matching files.
        "overrides": [
          {
            "include": ["test/**/*.ts"],
            "options": {
              "diagnosticSeverity": {
                "asyncFunction": "off"
              }
            }
          }
        ]
      }
    ]
  }
}
```

Severity values are `"off"`, `"error"`, `"warning"`, `"suggestion"`, and
`"message"`. Inherited configuration, per-file overrides, and source suppression
directives are supported:

```ts
// @effect-diagnostics-next-line floatingEffect:off
Effect.succeed(42)
```

To select rules for a single run, also opting in when no plugin entry exists:

```sh
npx effect-tsrs diagnostics --project tsconfig.json --rules floatingEffect,asyncFunction
npx effect-tsrs diagnostics --project tsconfig.json --rules all
```

Explicit severity settings and suppression directives still apply.
`--rules none` disables the source-file Effect pass. Use `--lspconfig` to replace
the plugin options for a command:

```sh
npx effect-tsrs diagnostics --project tsconfig.json \
  --lspconfig '{"diagnosticSeverity":{"floatingEffect":"warning"}}'
```

The `allowedUnstableApis` and `allowedExperimentalApis` options accept module
paths or individual exports:

```json
{
  "allowedUnstableApis": ["effect/http", "effect/rpc/RpcClient#make"],
  "allowedExperimentalApis": ["my-package/Preview#make"]
}
```

A module path permits that module and its descendants; `#exportName` permits
only that export. Matching is case-sensitive and respects path segments.
Per-file overrides replace these lists.

Import preferences can also vary by file:

```json
{
  "namespaceImportPackages": ["effect"],
  "overrides": [
    {
      "include": ["src/legacy/**/*.ts"],
      "options": {
        "namespaceImportPackages": [],
        "barrelImportPackages": ["effect"]
      }
    }
  ]
}
```

## Development

See [the porting notes](PORTING.md) for source builds, verification, benchmarks,
and release instructions, and [the fixture guide](fixtures/all/HARNESS.md) for
focused rule comparisons.

## License

[MIT](LICENSE). Rules and diagnostic descriptions are adapted from
[Effect-TS/tsgo](https://github.com/Effect-TS/tsgo).
Compiler and dependency notices are included in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
