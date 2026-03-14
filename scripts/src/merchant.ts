import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import keyPairJson from "../keypair.json" with { type: "json" };

const keypair = Ed25519Keypair.fromSecretKey(keyPairJson.privateKey);
const client = new SuiGrpcClient({
  network: 'testnet',
  baseUrl: 'https://fullnode.testnet.sui.io:443',
});

const CTF_PACKAGE = '0x936313e502e9cbf6e7a04fe2aeb4c60bc0acd69729acc7a19921b33bebf72d03';
const USDC_TYPE = '0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC';
const COST = 3849000;

(async () => {
  const address = keypair.toSuiAddress();

  // Fetch USDC coins via JSON-RPC directly
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
  if (!coins || coins.length === 0) throw new Error('No USDC found!');
  console.log('USDC found:', coins[0].balance);

  const tx = new Transaction();
  const [paymentCoin] = tx.splitCoins(tx.object(coins[0].coinObjectId), [COST]);

  const [flag] = tx.moveCall({
    target: `${CTF_PACKAGE}::merchant::buy_flag`,
    arguments: [paymentCoin],
  });

  tx.transferObjects([flag], address);

  const result = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  console.log('Flag captured!', result.Transaction?.status);
})();