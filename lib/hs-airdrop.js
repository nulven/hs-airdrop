'use strict';

const assert = require('bsert');
const os = require('os');
const fs = require('bfile');
const request = require('brq');
const Path = require('path');
const bio = require('bufio');
const pgp = require('bcrypto/lib/pgp');
const ssh = require('bcrypto/lib/ssh');
const bech32 = require('bcrypto/lib/encoding/bech32');
const blake2b = require('bcrypto/lib/blake2b');
const sha256 = require('bcrypto/lib/sha256');
const merkle = require('bcrypto/lib/mrkl');
const hkdf = require('bcrypto/lib/hkdf');
const fixed = require('../lib/fixed');
const AirdropKey = require('../lib/key');
const AirdropProof = require('../lib/proof');
const readline = require('../lib/readline');
const pkg = require('../package.json');
const tree = require('../etc/tree.json');
const faucet = require('../etc/faucet.json');
const tree_dev = require('../etc_dev/tree.json');
const faucet_dev = require('../etc_dev/faucet.json');
const {PGPMessage, SecretKey} = pgp;
const {SSHPrivateKey} = ssh;
const {readLine, readPassphrase, getUserInput} = readline;

const {
  PUBLIC_KEY,
  PRIVATE_KEY
} = pgp.packetTypes;

/*
 * Constants
 */

let BUILD_DIR = Path.resolve(process.cwd(), 'build');

const NONCE_DIR = Path.resolve(BUILD_DIR, 'nonces');
const GITHUB_URL = 'https://github.com/handshake-org/hs-tree-data/raw/master';

let TREE_CHECKSUM;
let TREE_LEAVES;
let SUBTREE_LEAVES;
let TREE_CHECKSUMS;

let FAUCET_CHECKSUM;
let FAUCET_LEAVES;
let PROOF_CHECKSUM;

const ADDR = 'hs1q5z7yyk8xrh4quqg3kw498ngy7hnd4sruqyxnxd';

const HELP = `
  hs-airdrop (v${pkg.version})

  This tool will create the proof necessary to
  collect your faucet reward, airdrop reward, or
  sponsor reward on the Handshake blockchain.

  Usage: $ hs-airdrop [key-file] [id] [addr] [options]
         $ hs-airdrop [key-file] [addr] [options]
         $ hs-airdrop [addr]

  Options:

    -v, --version         output the version number
    -b, --bare            redeem airdrop publicly (i.e. without goosig)
    -f, --fee <amount>    set fee for redemption (default: 0.1 HNS)
    -d, --data <path>     data directory for cache (default: ~/.hs-tree-data)
    -h, --help            output usage information

  [key-file] can be:

    - An SSH private key file.
    - An exported PGP armor keyring (.asc).
    - An exported PGP raw keyring (.pgp/.gpg).

  [id] is only necessary for PGP keys.

  [addr] must be a Handshake bech32 address.

  The --bare flag will use your existing public key.
  This is not recommended as it makes you identifiable
  on-chain.

  This tool will provide a JSON representation of
  your airdrop proof as well as a base64 string.

  The base64 string must be passed to:
    $ hsd-rpc sendrawairdrop "base64-string"

  Examples:

    $ hs-airdrop ~/.gnupg/secring.gpg 0x12345678 ${ADDR} -f 0.5
    $ hs-airdrop ~/.ssh/id_rsa ${ADDR} -f 0.5
    $ hs-airdrop ~/.ssh/id_rsa ${ADDR} -f 0.5 --bare
    $ hs-airdrop ${ADDR}
`;

/*
 * Airdrop
 */

async function readFile(...path) {
  if (!await fs.exists(BUILD_DIR))
    await fs.mkdir(BUILD_DIR, 0o755);

  if (!await fs.exists(NONCE_DIR))
    await fs.mkdir(NONCE_DIR, 0o755);

  const checksum = Buffer.from(path.pop(), 'hex');
  const url = `${GITHUB_URL}/${path.join('/')}`;
  const file = Path.resolve(BUILD_DIR, ...path);
  const base = Path.basename(file);

  if (!await fs.exists(file)) {
    console.log('Downloading: %s...', url);

    const req = await request({
      url,
      limit: 100 << 20,
      timeout: 10 * 60 * 1000,
    });

    const raw = req.buffer();

    if (!sha256.digest(raw).equals(checksum))
      throw new Error(`Invalid checksum: ${base}`);

    return raw;
  }

  const raw = await fs.readFile(file);

  if (!sha256.digest(raw).equals(checksum))
    throw new Error(`Invalid checksum: ${base}`);

  return raw;
}

async function readTreeFile() {
  return readFile('tree.bin', TREE_CHECKSUM);
}

async function readFaucetFile() {
  return readFile('faucet.bin', FAUCET_CHECKSUM);
}

async function readNonceFile(index) {
  assert((index & 0xff) === index);
  return readFile('nonces', `${pad(index)}.bin`, TREE_CHECKSUMS[index]);
}

async function readProofFile() {
  const raw = await readFile('proof.json', PROOF_CHECKSUM);
  return JSON.parse(raw.toString('utf8'));
}

async function readLeaves() {
  const data = await readTreeFile();
  const br = bio.read(data);
  const totalLeaves = br.readU32();
  const leaves = [];

  for (let i = 0; i < totalLeaves; i++) {
    const hashes = [];

    for (let j = 0; j < SUBTREE_LEAVES; j++) {
      const hash = br.readBytes(32, true);
      hashes.push(hash);
    }

    leaves.push(hashes);
  }

  assert.strictEqual(br.left(), 0);
  assert.strictEqual(totalLeaves, TREE_LEAVES);

  return leaves;
}

function flattenLeaves(leaves) {
  assert(Array.isArray(leaves));

  const out = [];

  for (const hashes of leaves) {
    const root = merkle.createRoot(blake2b, hashes);
    out.push(root);
  }

  return out;
}

function findLeaf(leaves, target) {
  assert(Array.isArray(leaves));
  assert(Buffer.isBuffer(target));

  for (let i = 0; i < leaves.length; i++) {
    const hashes = leaves[i];

    // Could do a binary search here.
    for (let j = 0; j < hashes.length; j++) {
      const hash = hashes[j];

      if (hash.equals(target))
        return [i, j];
    }
  }

  return [-1, -1];
}

async function readFaucetLeaves() {
  const data = await readFaucetFile();
  const br = bio.read(data);
  const totalLeaves = br.readU32();
  const leaves = [];

  for (let i = 0; i < totalLeaves; i++) {
    const hash = br.readBytes(32);
    leaves.push(hash);
  }

  assert.strictEqual(br.left(), 0);
  assert.strictEqual(totalLeaves, FAUCET_LEAVES);

  return leaves;
}

function findFaucetLeaf(leaves, target) {
  assert(Array.isArray(leaves));
  assert(Buffer.isBuffer(target));

  // Could do a binary search here.
  for (let i = 0; i < leaves.length; i++) {
    const leaf = leaves[i];

    if (leaf.equals(target))
      return i;
  }

  return -1;
}

async function findNonces(key, priv) {
  assert(key instanceof AirdropKey);
  assert((priv instanceof SecretKey)
      || (priv instanceof SSHPrivateKey));

  const bucket = key.bucket();
  const data = await readNonceFile(bucket);
  const br = bio.read(data);
  const out = [];

  while (br.left()) {
    const ct = br.readBytes(br.readU16(), true);

    try {
      out.push(key.decrypt(ct, priv));
    } catch (e) {
      continue;
    }
  }

  if (out.length === 0) {
    const err = new Error();
    err.name = 'NonceError';
    err.message = `Could not find nonce in bucket ${bucket}.`;
    throw err;
  }

  return out;
}

async function createAddrProofs(options) {
  assert(options != null);
  assert(Array.isArray(options.entries));

  const leaves = await readFaucetLeaves();
  const proofs = [];

  for (const {pub} of options.entries) {
    const index = findFaucetLeaf(leaves, pub.hash());

    if (index === -1)
      throw new Error('Could not find leaf.');

    console.log('Creating proof from leaf %d...', index);

    const proof = merkle.createBranch(blake2b, index, leaves);
    const p = new AirdropProof();

    p.index = index;
    p.proof = proof;
    p.key = pub.encode();
    p.version = pub.version;
    p.address = pub.address;
    p.fee = pub.sponsor ? 500e6 : 100e6;

    assert(p.fee <= p.getValue());

    if (!p.verify())
      throw new Error('Proof failed verification.');

    proofs.push(p);
  }

  return proofs;
}

async function createKeyProofs(options) {
  assert(options != null && options.key != null);
  assert(options.key.pub instanceof AirdropKey);

  const {pub, priv} = options.key;

  console.log('Decrypting nonce...');

  const items = await findNonces(pub, priv);

  console.log('Found nonce!');
  console.log('Rebuilding tree...');

  const leaves = await readLeaves();
  const tree = flattenLeaves(leaves);
  const proofs = [];

  for (const [i, [nonce, seed]] of items.entries()) {
    const key = pub.clone();

    if (options.bare)
      key.applyNonce(nonce);
    else
      key.applyTweak(nonce);

    console.log('Finding merkle leaf for reward %d...', i);

    const [index, subindex] = findLeaf(leaves, key.hash());

    if (index === -1)
      throw new Error('Could not find leaf.');

    const subtree = leaves[index];

    diffSubtree(key, nonce, seed, subtree);

    console.log('Creating proof from leaf %d:%d...', index, subindex);

    const subproof = merkle.createBranch(blake2b, subindex, subtree);
    const proof = merkle.createBranch(blake2b, index, tree);
    const p = new AirdropProof();

    p.index = index;
    p.proof = proof;
    p.subindex = subindex;
    p.subproof = subproof;
    p.key = key.encode();
    p.version = options.version;
    p.address = options.hash;
    p.fee = options.fee;

    if (p.fee > p.getValue())
      throw new Error('Fee exceeds value!');

    console.log('Signing proof %d:%d...', index, subindex);

    p.sign(key, priv);

    if (!p.verify())
      throw new Error('Proof failed verification.');

    proofs.push(p);
  }

  return proofs;
}

function deriveSubleaves(seed) {
  const len = SUBTREE_LEAVES * 32;
  const prk = hkdf.extract(sha256, seed);
  const raw = hkdf.expand(sha256, prk, null, len);
  const hashes = [];

  for (let i = 0; i < len; i += 32)
    hashes.push(raw.slice(i, i + 32));

  return hashes;
}

function diffSubtree(key, nonce, seed, subtree) {
  assert(key instanceof AirdropKey);
  assert(Buffer.isBuffer(seed));
  assert(Array.isArray(subtree));

  // Derive subtree leaves.
  const hashes = deriveSubleaves(seed);

  // Filter out synthetic hashes.
  // This basically proves that the generation
  // script did not do anything malicious. It
  // also informs the user that other keys are
  // available to use.
  const keyHashes = [];

  for (const hash of subtree) {
    let synthetic = false;

    for (const h of hashes) {
      if (h.equals(hash)) {
        synthetic = true;
        break;
      }
    }

    if (!synthetic)
      keyHashes.push(hash);
  }

  console.log('');
  console.log('%d keys found in your subtree:', keyHashes.length);

  const keyHash = key.hash();

  for (const hash of keyHashes) {
    if (keyHash.equals(hash))
      console.log('  %s (current)', hash.toString('hex'));
    else
      console.log('  %s', hash.toString('hex'));
  }

  console.log('');
}

/*
 * CLI
 */

async function parsePGP(msg, keyID) {
  assert(msg instanceof PGPMessage);
  assert(Buffer.isBuffer(keyID));

  let priv = null;
  let pub = null;

  for (const pkt of msg.packets) {
    if (pkt.type === PRIVATE_KEY) {
      const key = pkt.body;

      if (key.key.matches(keyID)) {
        priv = key;
        pub = key.key;
        continue;
      }

      continue;
    }

    if (pkt.type === PUBLIC_KEY) {
      const key = pkt.body;

      if (key.matches(keyID)) {
        pub = key;
        continue;
      }

      continue;
    }
  }

  if (!priv && !pub)
    throw new Error(`Could not find key for ID: ${keyID}.`);

  if (!priv) {
    return {
      type: 'pgp',
      pub: AirdropKey.fromPGP(pub),
      priv: null
    };
  }

  let passphrase = null;

  if (priv.params.encrypted) {
    console.log(`I found key ${pgp.encodeID(keyID)}, but it's encrypted.`);

    passphrase = await readPassphrase();
  }

  return {
    type: 'pgp',
    pub: AirdropKey.fromPGP(priv.key),
    priv: priv.secret(passphrase)
  };
}

function getType(arg) {
  assert(typeof arg === 'string');

  const ext = Path.extname(arg);

  switch (ext) {
    case '.asc':
    case '.pgp':
    case '.gpg':
      return 'pgp';
    default:
      return bech32.test(arg) ? 'addr' : 'ssh';
  }
}

async function readKey(data, file, keyID) {
  assert(typeof file === 'string');
  assert(keyID == null || Buffer.isBuffer(keyID));

  const ext = Path.extname(file);

  switch (ext) {
    case '.asc': {
      assert(keyID);
      const str = data.toString('utf8');
      const msg = PGPMessage.fromString(str);
      return parsePGP(msg, keyID);
    }

    case '.pgp':
    case '.gpg': {
      assert(keyID);
      const msg = PGPMessage.decode(data);
      return parsePGP(msg, keyID);
    }

    default: {
      const str = data.toString('utf8');
      const passphrase = await readPassphrase();
      const key = SSHPrivateKey.fromString(str, passphrase);
      return {
        type: 'ssh',
        pub: AirdropKey.fromSSH(key),
        priv: key.toString()
      };
    }
  }
}

async function readEntries(addr) {
  const [, target] = parseAddress(addr);
  const items = await readProofFile();
  const out = [];

  for (const [address, value, sponsor] of items) {
    const [, hash] = parseAddress(address);

    if (!hash.equals(target))
      continue;

    out.push({
      type: 'addr',
      pub: AirdropKey.fromAddress(addr, value, sponsor),
      priv: null
    });
  }

  if (out.length === 0)
    throw new Error('Address is not a faucet or sponsor address.');

  return out;
}

function getArgs(argv) {
  assert(Array.isArray(argv));

  const args = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    assert(typeof arg === 'string');

    if (arg.startsWith('--')) {
      // e.g. --opt
      const index = arg.indexOf('=');
      if (index !== -1) {
        // e.g. --opt=val
        args.push(arg.substring(0, index));
        args.push(arg.substring(index + 1));
      } else {
        args.push(arg);
      }
    } else if (arg.startsWith('-')) {
      if (arg.length > 2) {
        // e.g. -abc
        for (let j = 1; j < arg.length; j++)
          args.push(`-${arg.charAt(j)}`);
      } else {
        // e.g. -a
        args.push(arg);
      }
    } else {
      // e.g. foo
      args.push(arg);
    }
  }

  return args;
}

async function main(key, address, fee, environment) {
  const tree_chosen = environment === 'production' ? tree : tree_dev;
  TREE_CHECKSUM = tree_chosen.checksum;
  TREE_LEAVES = tree_chosen.leaves;
  SUBTREE_LEAVES = tree_chosen.subleaves;
  TREE_CHECKSUMS = tree_chosen.checksums;

  const faucet_chosen = environment === 'production' ? faucet : faucet_dev;
  FAUCET_CHECKSUM = faucet_chosen.checksum;
  FAUCET_LEAVES = faucet_chosen.leaves;
  PROOF_CHECKSUM = faucet_chosen.proofChecksum;

  const options = {
    __proto__: null,
    files: [],
    bare: false,
    type: null,
    key: null,
    entries: [],
    addr: null,
    fee: 1e5,
    version: 0,
    hash: null
  };
  [options.version, options.hash] = parseAddress(address);
  options.files = [address];
  const [addr] = options.files;

  options.addr = addr;
  options.key = { type: key.type, pub: AirdropKey.fromJSON(key.pub), priv: SSHPrivateKey.fromString(key.priv) };

  options.fee = fixed.decode(fee, 6);

  console.log('Attempting to create proof.');
  console.log('This may take a bit.');

  const proofs = options.type !== 'addr'
    ? (await createKeyProofs(options))
    : (await createAddrProofs(options));

  for (const [i, proof] of proofs.entries()) {
    return proof.toBase64();
  }
}

/*
 * Helpers
 */

function pad(index) {
  assert((index & 0xff) === index);

  let str = index.toString(10);

  while (str.length < 3)
    str = '0' + str;

  return str;
}

function parseAddress(addr) {
  const [hrp, version, hash] = bech32.decode(addr);

  if (hrp !== 'hs' && hrp !== 'ts' && hrp !== 'rs')
    throw new Error('Invalid address HRP.');

  if (version !== 0)
    throw new Error('Invalid address version.');

  if (hash.length !== 20 && hash.length !== 32)
    throw new Error('Invalid address.');

  return [version, hash];
}

module.exports = {
  main,
  readKey
};
