// The types of the modules that are already TypeScript, under global names, for the JavaScript
// that is still hand-written (TS-STEP-1, 1 November 2026). Type checking only (jsconfig.json reads
// it); tsc emits nothing for it, and the site and the app never load it (types/ is excluded from
// both). The closing commit of the move deletes it with jsconfig.json and the rest of types/.
//
// Why it is needed. A hand-written module named a type of another module with a JSDoc import such
// as {import('./taxonomy.js').Tier}. Once that module is TypeScript, './taxonomy.js' is its compiled
// output, which has no types left, so the checker would read it as plain JavaScript and find no Tier.
// The other ways to reach the source do not work here: a stamped specifier ('./taxonomy.js?v=...')
// in a comment is not kept current by bump_assets.py, and a bare 'ms-src/...' specifier is refused
// by the Android build's reference scan even inside a comment. So each JSDoc import of a moved
// module becomes the name below, and this file reaches the source through the jsconfig.json path
// map ("ms-src/*" is ts/src/* first). Each later conversion adds its module here when hand-written
// JavaScript still names its types.

/** The types of ts/src/core/taxonomy.ts. */
declare namespace Taxonomy {
  type Tier = import('ms-src/core/taxonomy.js').Tier;
  type Item = import('ms-src/core/taxonomy.js').Item;
  type ItemSpec = import('ms-src/core/taxonomy.js').ItemSpec;
  type ItemInternal = import('ms-src/core/taxonomy.js').ItemInternal;
  type ItemSet = import('ms-src/core/taxonomy.js').ItemSet;
}

/** The types of ts/src/core/icc.ts. */
declare namespace Icc {
  type IccTag = import('ms-src/core/icc.js').IccTag;
  type IccHeaderFix = import('ms-src/core/icc.js').IccHeaderFix;
  type IccInfo = import('ms-src/core/icc.js').IccInfo;
  type IccTextRead = import('ms-src/core/icc.js').IccTextRead;
}
