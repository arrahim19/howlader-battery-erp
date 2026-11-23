/**
 * Howlader ERP Sync v1 — runs in the owner's Google Apps Script account.
 * Paste this WHOLE file into Code.gs, save, run setupHowladerSync, then deploy
 * as a Web app: Execute as Me; Who has access: Anyone.
 * Never share the Drive root/pairing files publicly. Device tokens are secrets.
 */
var HB_SHOPS = [
  { name: "Betagi", devices: ["Phone", "Desktop"] },
  { name: "Mirzaganj", devices: ["Phone"] },
];
var HB_PROTOCOL = 1;
var HB_MAX_REQUEST = 8 * 1024 * 1024;
var HB_LEASE_MS = 3 * 60 * 1000;

/** Run only from the Apps Script editor as the Drive owner. Safe to rerun. */
function setupHowladerSync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error("Setup is busy. Try again.");
  try {
    var props = PropertiesService.getScriptProperties();
    var rootId = props.getProperty("HB_ROOT");
    var root = rootId
      ? DriveApp.getFolderById(rootId)
      : DriveApp.createFolder("Howlader ERP Sync");
    if (!rootId) props.setProperty("HB_ROOT", root.getId());
    if (!props.getProperty("HB_SERVICE_ID"))
      props.setProperty("HB_SERVICE_ID", Utilities.getUuid());
    var registry = JSON.parse(props.getProperty("HB_SHOPS") || "[]");
    HB_SHOPS.forEach(function (entry) {
      var name = String(entry.name || "").trim();
      if (!name || name.length > 80)
        throw new Error("Each shop needs a name of 1–80 characters.");
      var shop = registry.filter(function (item) {
        return item.name === name;
      })[0];
      if (!shop) {
        var id = Utilities.getUuid();
        var folder = root.createFolder(name + " - " + id);
        shop = { id: id, name: name, folderId: folder.getId() };
        registry.push(shop);
        props.setProperty("HB_SHOPS", JSON.stringify(registry));
      }
      entry.devices.forEach(function (deviceName) {
        hbPairDevice_(props, root, shop, deviceName);
      });
    });
    hbPrivateJson_(root, "SETUP-INSTRUCTIONS.json", {
      service: "Howlader ERP Sync",
      protocol: HB_PROTOCOL,
      serviceId: props.getProperty("HB_SERVICE_ID"),
      shops: registry.map(function (shop) {
        return { id: shop.id, name: shop.name };
      }),
      instructions:
        "Keep all pairing files private. Each device imports only its own pairing file. No Gmail password or Drive OAuth token belongs in the app. Deploy this script as a Web app, execute as Me, access Anyone. The app also needs its local ERP database engine; deployment alone does not migrate the ERP.",
    });
    console.log("Setup complete. Private Drive folder: " + root.getUrl());
    console.log(
      "No device tokens are printed in the execution log. Pairing files are inside the private Drive folder.",
    );
  } finally {
    lock.releaseLock();
  }
}

/** Optional owner action: revoke one device by setting HB_REVOKE_DEVICE_ID
 * in Project Settings > Script properties, then run this function. */
function revokeHowladerDevice() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error("Busy. Try again.");
  try {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty("HB_REVOKE_DEVICE_ID");
    if (!id) throw new Error("Set HB_REVOKE_DEVICE_ID first.");
    var all = props.getProperties();
    Object.keys(all).forEach(function (key) {
      if (key.indexOf("HB_DEVICE_") !== 0) return;
      var device = JSON.parse(all[key]);
      if (device.id === id) {
        device.active = false;
        props.setProperty(key, JSON.stringify(device));
        var leaseKey = "HB_LEASE_" + device.shopId;
        var lease = JSON.parse(props.getProperty(leaseKey) || "null");
        if (lease && lease.deviceId === id) props.deleteProperty(leaseKey);
      }
    });
    props.deleteProperty("HB_REVOKE_DEVICE_ID");
    console.log(
      "Revocation applied. Old private pairing files do not reactivate a revoked device.",
    );
  } finally {
    lock.releaseLock();
  }
}

function doGet(event) {
  if (event && event.pathInfo === "oauth/callback") return hbGoogleCallback_(event);
  return hbJson_({
    ok: true,
    data: {
      service: "Howlader ERP Sync",
      protocol: HB_PROTOCOL,
      ready: Boolean(
        PropertiesService.getScriptProperties().getProperty("HB_SERVICE_ID"),
      ),
    },
  });
}

function doPost(event) {
  var lock;
  try {
    var raw = event && event.postData && event.postData.contents;
    if (typeof raw !== "string" || raw.length > HB_MAX_REQUEST)
      hbFail_("BAD_REQUEST", "Missing or oversized request.");
    var input;
    try {
      input = JSON.parse(raw);
    } catch (_) {
      hbFail_("BAD_REQUEST", "Request must be JSON.");
    }
    if (
      !input ||
      input.protocol !== HB_PROTOCOL ||
      typeof input.op !== "string"
    )
      hbFail_("BAD_REQUEST", "Unsupported sync protocol.");
    if (["loginStart", "loginPoll", "loginAck"].indexOf(input.op) !== -1) return hbLoginPost_(input);
    if (
      ["status", "claim", "renew", "release", "pull", "push"].indexOf(
        input.op,
      ) === -1
    )
      hbFail_("BAD_REQUEST", "Unknown sync operation.");
    var props = PropertiesService.getScriptProperties();
    var device = hbAuthenticate_(props, input.token);
    if (input.serviceId !== props.getProperty("HB_SERVICE_ID"))
      hbFail_("WRONG_SERVICE", "This pairing belongs to another sync project.");
    var registry = JSON.parse(props.getProperty("HB_SHOPS") || "[]");
    var shop = registry.filter(function (entry) {
      return entry.id === device.shopId;
    })[0];
    if (!shop) hbFail_("ACCESS_DENIED", "Shop access is unavailable.");
    // Serialize the head-pointer update across all writers, including accidental
    // simultaneous devices. Authentication never accepts a caller-supplied shop.
    lock = LockService.getScriptLock();
    if (!lock.tryLock(20000))
      hbFail_("BUSY", "Sync is busy. Retry with the same operation ID.");
    // Recheck revocation after obtaining the lock.
    device = hbAuthenticate_(props, input.token);
    var head = JSON.parse(props.getProperty("HB_HEAD_" + shop.id) || "null");
    var revision = head ? head.revision : 0;
    var leaseKey = "HB_LEASE_" + shop.id;
    var lease = JSON.parse(props.getProperty(leaseKey) || "null");
    var now = Date.now();
    if (input.op === "status")
      return hbJson_({ ok: true, data: hbStatus_(shop, head, lease, device) });
    if (input.op === "release") {
      if (lease && lease.deviceId !== device.id && lease.expiresAt > now)
        hbFail_("DEVICE_BUSY", "Another device has this shop open.");
      if (lease && lease.deviceId === device.id && lease.id !== input.leaseId)
        hbFail_("LEASE_LOST", "The device session changed.");
      props.deleteProperty(leaseKey);
      return hbJson_({ ok: true, data: { released: true } });
    }
    if (input.op === "claim" || input.op === "renew") {
      if (lease && lease.deviceId !== device.id && lease.expiresAt > now)
        hbFail_(
          "DEVICE_BUSY",
          "Another device has this shop open. Finish syncing there first.",
        );
      if (
        input.op === "renew" &&
        (!lease ||
          lease.deviceId !== device.id ||
          lease.id !== input.leaseId ||
          lease.expiresAt <= now)
      )
        hbFail_("LEASE_LOST", "Refresh and claim this device again.");
      lease = {
        id:
          lease && lease.deviceId === device.id && lease.expiresAt > now
            ? lease.id
            : Utilities.getUuid(),
        deviceId: device.id,
        deviceName: device.name,
        expiresAt: now + HB_LEASE_MS,
      };
      props.setProperty(leaseKey, JSON.stringify(lease));
      return hbJson_({
        ok: true,
        data: {
          leaseId: lease.id,
          expiresAt: lease.expiresAt,
          head: hbPublicHead_(head),
          shop: { id: shop.id, name: shop.name },
        },
      });
    }
    if (input.op === "pull") {
      if (!head || input.knownRevision === revision)
        return hbJson_({
          ok: true,
          data: { head: hbPublicHead_(head), unchanged: true },
        });
      var payload = DriveApp.getFileById(head.payloadFileId)
        .getBlob()
        .getDataAsString();
      if (!hbEqual_(hbHash_(payload), head.payloadHash))
        hbFail_(
          "CORRUPT_BACKUP",
          "Backup checksum does not match. Retain local data and contact the owner.",
        );
      return hbJson_({
        ok: true,
        data: { head: hbPublicHead_(head), unchanged: false, payload: payload },
      });
    }
    return hbPush_(input, props, shop, device, head, lease, now);
  } catch (error) {
    // Do not log request bodies, device credentials, payloads or Drive tokens.
    return hbJson_({
      ok: false,
      error: {
        code: (error && error.hbCode) || "SERVICE_UNAVAILABLE",
        message:
          error && error.hbCode
            ? error.message
            : "Google sync is temporarily unavailable. Keep local data and retry.",
      },
    });
  } finally {
    if (lock && lock.hasLock()) lock.releaseLock();
  }
}

function hbPush_(input, props, shop, device, head, lease, now) {
  if (
    typeof input.writeId !== "string" ||
    !/^[a-zA-Z0-9-]{16,80}$/.test(input.writeId)
  )
    hbFail_("BAD_REQUEST", "A stable operation ID is required.");
  if (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0)
    hbFail_("BAD_REQUEST", "A valid base revision is required.");
  if (
    typeof input.payload !== "string" ||
    !input.payload ||
    input.payload.length > HB_MAX_REQUEST - 4096
  )
    hbFail_("BAD_REQUEST", "Invalid snapshot payload size.");
  if (input.payloadFormat !== "a256gcm-v1")
    hbFail_("BAD_REQUEST", "An encrypted version-1 snapshot is required.");
  if (
    typeof input.payloadHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.payloadHash) ||
    !hbEqual_(hbHash_(input.payload), input.payloadHash)
  )
    hbFail_("BAD_REQUEST", "Snapshot checksum is invalid.");
  var folder = DriveApp.getFolderById(shop.folderId);
  var operationName = input.writeId + ".meta.json";
  var existingFile = hbUniqueFile_(folder, operationName);
  var existing = existingFile
    ? JSON.parse(existingFile.getBlob().getDataAsString())
    : null;
  if (
    existing &&
    (existing.deviceId !== device.id ||
      existing.payloadHash !== input.payloadHash ||
      existing.baseRevision !== input.baseRevision)
  )
    hbFail_(
      "OPERATION_REUSED",
      "This operation ID already belongs to another snapshot.",
    );
  // A lost response must never result in another revision or another sale.
  if (existing && hbCommitted_(existingFile.getId(), existing.revision, head))
    return hbJson_({
      ok: true,
      data: {
        revision: existing.revision,
        currentRevision: head.revision,
        writeId: existing.writeId,
        repeated: true,
      },
    });
  if (
    !lease ||
    lease.deviceId !== device.id ||
    lease.id !== input.leaseId ||
    lease.expiresAt <= now
  )
    hbFail_(
      "LEASE_LOST",
      "Claim this device before uploading. Local work is retained.",
    );
  var currentRevision = head ? head.revision : 0;
  if (input.baseRevision !== currentRevision)
    hbFail_(
      "REVISION_CONFLICT",
      "Drive has a newer version. Do not overwrite it; keep local work for reconciliation.",
    );
  var payloadFile = hbUniqueFile_(folder, input.writeId + ".snapshot");
  if (
    payloadFile &&
    !hbEqual_(
      hbHash_(payloadFile.getBlob().getDataAsString()),
      input.payloadHash,
    )
  )
    hbFail_("OPERATION_REUSED", "Operation payload changed.");
  if (!payloadFile)
    payloadFile = folder.createFile(
      input.writeId + ".snapshot",
      input.payload,
      MimeType.PLAIN_TEXT,
    );
  var record = existing || {
    protocol: HB_PROTOCOL,
    shopId: shop.id,
    revision: currentRevision + 1,
    baseRevision: currentRevision,
    writeId: input.writeId,
    deviceId: device.id,
    createdAt: new Date().toISOString(),
    payloadFormat: input.payloadFormat,
    payloadHash: input.payloadHash,
    payloadFileId: payloadFile.getId(),
    previousManifestId: head ? head.manifestFileId : null,
  };
  if (!existingFile)
    existingFile = folder.createFile(
      operationName,
      JSON.stringify(record),
      MimeType.PLAIN_TEXT,
    );
  record.manifestFileId = existingFile.getId();
  // This single property is the commit point. Previous snapshots stay immutable.
  props.setProperty("HB_HEAD_" + shop.id, JSON.stringify(record));
  lease.expiresAt = Date.now() + HB_LEASE_MS;
  props.setProperty("HB_LEASE_" + shop.id, JSON.stringify(lease));
  return hbJson_({
    ok: true,
    data: {
      revision: record.revision,
      currentRevision: record.revision,
      writeId: record.writeId,
      repeated: false,
    },
  });
}

function hbCommitted_(manifestId, revision, head) {
  var cursor = head;
  var checked = 0;
  while (cursor && cursor.revision >= revision) {
    if (cursor.revision === revision)
      return cursor.manifestFileId === manifestId;
    if (!cursor.previousManifestId) return false;
    if (++checked > 1000)
      hbFail_(
        "HISTORY_CHECK_REQUIRED",
        "Old pending operation needs owner review. Retain local data.",
      );
    var parentId = cursor.previousManifestId;
    var previous = JSON.parse(
      DriveApp.getFileById(parentId).getBlob().getDataAsString(),
    );
    if (
      previous.shopId !== head.shopId ||
      previous.revision !== cursor.revision - 1
    )
      hbFail_("CORRUPT_BACKUP", "Snapshot history is inconsistent.");
    previous.manifestFileId = parentId;
    cursor = previous;
  }
  return false;
}

function hbPairDevice_(props, root, shop, name) {
  if (typeof name !== "string" || !name.trim() || name.length > 80)
    throw new Error("Invalid device name.");
  var indexKey = "HB_PAIR_" + hbHash_(shop.id + ":" + name);
  if (props.getProperty(indexKey)) return;
  var token =
    Utilities.getUuid().replace(/-/g, "") +
    Utilities.getUuid().replace(/-/g, "");
  var device = {
    id: Utilities.getUuid(),
    shopId: shop.id,
    name: name,
    active: true,
  };
  var pairing = {
    protocol: HB_PROTOCOL,
    serviceId: props.getProperty("HB_SERVICE_ID"),
    shopId: shop.id,
    shopName: shop.name,
    deviceId: device.id,
    deviceName: name,
    token: token,
  };
  var file = hbPrivateJson_(
    root,
    "PRIVATE-PAIRING-" + shop.name + "-" + name + ".json",
    pairing,
  );
  props.setProperty("HB_DEVICE_" + hbHash_(token), JSON.stringify(device));
  props.setProperty(indexKey, file.getId());
}
function hbAuthenticate_(props, token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
    hbFail_("ACCESS_DENIED", "Invalid device credentials.");
  var stored = props.getProperty("HB_DEVICE_" + hbHash_(token));
  if (!stored) hbFail_("ACCESS_DENIED", "Device is not registered.");
  var device = JSON.parse(stored);
  if (!device.active)
    hbFail_("ACCESS_DENIED", "Device access has been revoked.");
  if (device.expiresAt && device.expiresAt <= Date.now()) hbFail_("ACCESS_DENIED", "Sign in with Google again to renew this device.");
  if (device.userId) {
    var allowed = JSON.parse(props.getProperty("HB_LOGIN_EMAILS") || "{}");
    if (allowed[device.email] !== device.shopId) hbFail_("ACCESS_DENIED", "Account access has been removed.");
  }
  return device;
}
function hbStatus_(shop, head, lease, device) {
  return {
    shop: { id: shop.id, name: shop.name },
    head: hbPublicHead_(head),
    activeDevice:
      lease && lease.expiresAt > Date.now()
        ? {
            own: lease.deviceId === device.id,
            name: lease.deviceName,
            expiresAt: lease.expiresAt,
          }
        : null,
  };
}
function hbPublicHead_(head) {
  return head
    ? {
        revision: head.revision,
        writeId: head.writeId,
        deviceId: head.deviceId,
        createdAt: head.createdAt,
        payloadFormat: head.payloadFormat,
        payloadHash: head.payloadHash,
      }
    : { revision: 0 };
}
function hbUniqueFile_(folder, name) {
  var files = folder.getFilesByName(name);
  var first = files.hasNext() ? files.next() : null;
  if (files.hasNext())
    hbFail_(
      "CORRUPT_BACKUP",
      "Duplicate snapshot file names need owner review.",
    );
  return first;
}
function hbPrivateJson_(folder, name, value) {
  var file = hbUniqueFile_(folder, name);
  if (file) {
    file.setContent(JSON.stringify(value, null, 2));
    return file;
  }
  return folder.createFile(
    name,
    JSON.stringify(value, null, 2),
    MimeType.PLAIN_TEXT,
  );
}
function hbHash_(value) {
  return Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8,
  )
    .map(function (byte) {
      return ("0" + (byte & 255).toString(16)).slice(-2);
    })
    .join("");
}
function hbEqual_(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length)
    return false;
  var difference = 0;
  for (var i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function hbFail_(code, message) {
  var error = new Error(message);
  error.hbCode = code;
  throw error;
}
function hbJson_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(
    ContentService.MimeType.JSON,
  );
}
