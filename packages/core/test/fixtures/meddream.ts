/**
 * Synthetic MedDream viewer bodies. Key names, array lengths and value formats match the one captured
 * session; every UID is built on the Medical Connections free root 1.2.826.0.1.3680043.8.498, which
 * exists for test data, and every patient field is invented. No real UID, name, identification number,
 * accession number, institution or token appears here or anywhere in this repository's tests.
 */
export const STUDY_UID = "1.2.826.0.1.3680043.8.498.10000000000001.1700000000.1000001";
export const SERIES_UID = "1.2.826.0.1.3680043.8.498.20000000000002.1700000000.2001";
export const SOP_UID = "1.2.826.0.1.3680043.8.498.30000000000003.1700000000.3001";
/** The Secondary Capture instance the portal's own viewer skipped when fetching thumbnails. */
export const SECONDARY_SOP_UID = "1.2.826.0.1.3680043.8.498.30000000000003.1700000000.3011";
export const STORAGE_ID = "d4c5Dicomweb";
/** 32 uppercase hex, the measured shape of current_customer_info.checksum_id. */
export const CHECKSUM_ID = "0123456789ABCDEF0123456789ABCDEF";
/** Shapes only: 1311 characters of JWE and a 124-character base64url HIS token in the capture. */
export const HANDOFF_TOKEN = "synthetic.jwe.value.aaa.bbb";
export const HIS_TOKEN = "synthetic-his-token";
export const CSRF_TOKEN = "synthetic-csrf-token";

export const hisResponse = () => ({ studyIds: [{ studyUid: STUDY_UID, storageId: STORAGE_ID, modality: "US" }] });

export const studyStructure = () => ({
  studyInstanceUID: STUDY_UID,
  sourceApplicationEntityTitle: "",
  studyDate: "2024-05-14",
  studyTime: "10:22:41",
  studyDescription: "US SOFT TISSUE NECK",
  patientName: "TEST PATIENT",
  patientID: "0999999999",
  patientBirthDate: "1990-01-01",
  patientSex: "M",
  hasReport: false,
  reportIsAvailable: false,
  storageId: STORAGE_ID,
  mainModality: "US",
  series: [{
    seriesInstanceUID: SERIES_UID,
    modality: "US",
    seriesDescription: "1234",
    instances: [
      { transferSyntaxUID: "1.2.840.10008.1.2.4.70", sopInstanceUID: SOP_UID, sopClassUID: "1.2.840.10008.5.1.4.1.1.6.1", numberOfFrames: 0 },
      { transferSyntaxUID: "1.2.840.10008.1.2.4.70", sopInstanceUID: SECONDARY_SOP_UID, sopClassUID: "1.2.840.10008.5.1.4.1.1.7", numberOfFrames: 0 },
    ],
  }],
});

export const imageMetadata = () => ({
  transferSyntaxUID: "1.2.840.10008.1.2.1",
  imageType: "ORIGINAL\\PRIMARY\\SMALL PARTS\\0001\\GEMSSINGLEFRAME\\GEMSMGCOUNT1",
  sopClassUID: "1.2.840.10008.5.1.4.1.1.6.1",
  sopInstanceUID: SOP_UID,
  studyDate: "20240514",
  studyTime: "102241",
  modality: "US",
  seriesNumber: 1,
  instanceNumber: 0,
  studyInstanceUID: STUDY_UID,
  seriesInstanceUID: SERIES_UID,
  imagePositionPatient: [0, 0, 0],
  imageOrientationPatient: [0, 0, 0, 0, 0, 0],
  samplesPerPixel: 1,
  photometricInterpretation: "MONOCHROME2",
  numberOfFrames: 1,
  rows: 970,
  columns: 1552,
  bitsAllocated: 8,
  bitsStored: 8,
  pixelRepresentation: 0,
  windowCenter: [127],
  windowWidth: [256],
  accessionNumber: "ACC00000001",
  patientID: "0999999999",
  maxPixelValue: 255,
  viewPortLabels: { left: ["ACC00000001", "TEST PATIENT"], right: ["US SOFT TISSUE NECK", "2024-05-14", "SERIES 1", "IMAGE 1"] },
  suvBwScaleFactor: 0,
  sequenceOfUltrasoundRegions: [{ regionSpatialFormat: 1, regionDataType: 1, regionFlags: 0, regionLocationMinX0: 2, regionLocationMinY0: 158, regionLocationMaxX1: 1443, regionLocationMaxY1: 850, referencePixelX0: 721, referencePixelY0: -89, physicalUnitsXDirection: 3, physicalUnitsYDirection: 3, referencePixelPhysicalValueX: 0, referencePixelPhysicalValueY: 0, physicalDeltaX: 0.0057720056429913895, physicalDeltaY: 0.0057720056429913895, transducerFrequency: 12000 }],
  attributes: {
    "00100040": "M", "00100010": "TEST PATIENT", "00080070": "TEST VENDOR", "00081090": "MODEL-1",
    "00080080": "TEST CLINIC SITE", "00100030": "19900101", "00080090": "DR X", "00280002": "1",
    "00181000": "SN0000001", "00200010": "ACC00000001", "00081010": "ROOM01",
  },
  pixelAspectRatio: { x: 1, y: 1 },
  lossyCompressionMethod: "NOT_LOSSY",
});

/** Exactly rows x columns x samplesPerPixel x (bitsAllocated / 8) x frames, as measured. */
export const pixelBuffer = (metadata = imageMetadata()) =>
  new Uint8Array(metadata.rows * metadata.columns * metadata.samplesPerPixel * (metadata.bitsAllocated / 8) * metadata.numberOfFrames).fill(0x45);

/** Smallest thing that satisfies the captured markers: JFIF APP0 after SOI, EOI at the end. */
export const thumbnailJpeg = () =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

/** The auto-submitting form of hop 2, reduced to the two inputs a replaying client reads. */
export const samlPage = (samlResponse = "c3ludGhldGlj"): string =>
  `<html><body onload="document.forms[0].submit()"><form id="frmRedirect" action="https://meddreamy.maccabi4u.co.il/saml/sp/profile/post/acs" method="post">` +
  `<input type="hidden" name="SAMLResponse" value="${samlResponse}">` +
  `<input type="hidden" name="RelayState" value=""><input type="Submit" value="continue"></form></body></html>`;

/** Hop 4's 406-byte second-leg form, whose nonce must be echoed back. */
export const policyPage = (dummy = "0123456789abcdef0123456789abcdef"): string =>
  `<html><body><form method="POST" action="/saml/sp/profile/post/acs">` +
  `<input name="dummy" value="${dummy}"><input name="state" value="abcdefgh"></form></body></html>`;
