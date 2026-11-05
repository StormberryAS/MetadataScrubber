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

/** The types of ts/src/core/tiff.ts. */
declare namespace Tiff {
  type TiffEntry = import('ms-src/core/tiff.js').TiffEntry;
  type TiffIfd = import('ms-src/core/tiff.js').TiffIfd;
  type TiffModel = import('ms-src/core/tiff.js').TiffModel;
  type TiffItemDef = import('ms-src/core/tiff.js').TiffItemDef;
  type TiffItem = import('ms-src/core/tiff.js').TiffItem;
  type AppleHdr = import('ms-src/core/tiff.js').AppleHdr;
  type GreenSpec = import('ms-src/core/tiff.js').GreenSpec;
  type BytesCheck = import('ms-src/core/tiff.js').BytesCheck;
  type Placed = import('ms-src/core/tiff.js').Placed;
}

/** The types of ts/src/core/iptc.ts. */
declare namespace Iptc {
  type IptcDataset = import('ms-src/core/iptc.js').IptcDataset;
  type ParsedIptc = import('ms-src/core/iptc.js').ParsedIptc;
  type IptcItemDef = import('ms-src/core/iptc.js').IptcItemDef;
  type IptcItem = import('ms-src/core/iptc.js').IptcItem;
  type IrbResource = import('ms-src/core/iptc.js').IrbResource;
  type ParsedIrb = import('ms-src/core/iptc.js').ParsedIrb;
}

/** The types of ts/src/core/xmp.ts. */
declare namespace Xmp {
  type XmlAttr = import('ms-src/core/xmp.js').XmlAttr;
  type XmlText = import('ms-src/core/xmp.js').XmlText;
  type XmlComment = import('ms-src/core/xmp.js').XmlComment;
  type XmlPi = import('ms-src/core/xmp.js').XmlPi;
  type XmlElement = import('ms-src/core/xmp.js').XmlElement;
  type XmlNode = import('ms-src/core/xmp.js').XmlNode;
  type XmlRoot = import('ms-src/core/xmp.js').XmlRoot;
  type QName = import('ms-src/core/xmp.js').QName;
  type DirFieldName = import('ms-src/core/xmp.js').DirFieldName;
  type DirField = import('ms-src/core/xmp.js').DirField;
  type DirEntry = import('ms-src/core/xmp.js').DirEntry;
  type DirRef = import('ms-src/core/xmp.js').DirRef;
  type DirExtra = import('ms-src/core/xmp.js').DirExtra;
  type Directory = import('ms-src/core/xmp.js').Directory;
  type XmpPropBase = import('ms-src/core/xmp.js').XmpPropBase;
  type XmpAttrProp = import('ms-src/core/xmp.js').XmpAttrProp;
  type XmpElemProp = import('ms-src/core/xmp.js').XmpElemProp;
  type XmpAboutProp = import('ms-src/core/xmp.js').XmpAboutProp;
  type XmpSubProp = import('ms-src/core/xmp.js').XmpSubProp;
  type XmpHiddenProp = import('ms-src/core/xmp.js').XmpHiddenProp;
  type XmpProp = import('ms-src/core/xmp.js').XmpProp;
  type ParsedXmp = import('ms-src/core/xmp.js').ParsedXmp;
  type CanonProp = import('ms-src/core/xmp.js').CanonProp;
  type XmpAdd = import('ms-src/core/xmp.js').XmpAdd;
  type GainFix = import('ms-src/core/xmp.js').GainFix;
  type DirPatch = import('ms-src/core/xmp.js').DirPatch;
  type XmpItemDef = import('ms-src/core/xmp.js').XmpItemDef;
  type XmpItem = import('ms-src/core/xmp.js').XmpItem;
  type XmpCtx = import('ms-src/core/xmp.js').XmpCtx;
  type XmpAdded = import('ms-src/core/xmp.js').XmpAdded;
  type PlanOpts = import('ms-src/core/xmp.js').PlanOpts;
  type XmpPlan = import('ms-src/core/xmp.js').XmpPlan;
}

/** The types of ts/src/core/jpeg.ts. */
declare namespace Jpeg {
  type ParsedXmp = import('ms-src/core/jpeg.js').ParsedXmp;
  type XmpPacketItems = import('ms-src/core/jpeg.js').XmpPacketItems;
  type XmpDirectory = import('ms-src/core/jpeg.js').XmpDirectory;
  type XmpFieldProp = import('ms-src/core/jpeg.js').XmpFieldProp;
  type JpegAppKind = import('ms-src/core/jpeg.js').JpegAppKind;
  type JpegMarkerSegment = import('ms-src/core/jpeg.js').JpegMarkerSegment;
  type JpegBareSegment = import('ms-src/core/jpeg.js').JpegBareSegment;
  type JpegSegment = import('ms-src/core/jpeg.js').JpegSegment;
  type JpegSof = import('ms-src/core/jpeg.js').JpegSof;
  type JpegWalk = import('ms-src/core/jpeg.js').JpegWalk;
  type MpfEntry = import('ms-src/core/jpeg.js').MpfEntry;
  type MpfIndex = import('ms-src/core/jpeg.js').MpfIndex;
  type MpfFieldBase = import('ms-src/core/jpeg.js').MpfFieldBase;
  type MpfFitField = import('ms-src/core/jpeg.js').MpfFitField;
  type MpfField = import('ms-src/core/jpeg.js').MpfField;
  type MpfStrict = import('ms-src/core/jpeg.js').MpfStrict;
  type IsoGain = import('ms-src/core/jpeg.js').IsoGain;
  type GainSignals = import('ms-src/core/jpeg.js').GainSignals;
  type TrailingKind = import('ms-src/core/jpeg.js').TrailingKind;
  type TrailingRegion = import('ms-src/core/jpeg.js').TrailingRegion;
  type TrailingDef = import('ms-src/core/jpeg.js').TrailingDef;
  type TrailingItem = import('ms-src/core/jpeg.js').TrailingItem;
  type XmpPacket = import('ms-src/core/jpeg.js').XmpPacket;
  type JfifHeader = import('ms-src/core/jpeg.js').JfifHeader;
  type AdobeHeader = import('ms-src/core/jpeg.js').AdobeHeader;
  type JpegIrb = import('ms-src/core/jpeg.js').JpegIrb;
  type JpegModel = import('ms-src/core/jpeg.js').JpegModel;
  type TableDef = import('ms-src/core/jpeg.js').TableDef;
  type MpfOutField = import('ms-src/core/jpeg.js').MpfOutField;
  type PlacedPart = import('ms-src/core/jpeg.js').PlacedPart;
  type CleanParts = import('ms-src/core/jpeg.js').CleanParts;
  type IccTextInternal = import('ms-src/core/jpeg.js').IccTextInternal;
}
