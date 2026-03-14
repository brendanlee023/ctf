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

(async () => {
  const address = keypair.toSuiAddress();
  const tx = new Transaction();

  const [flag] = tx.moveCall({
    target: `${CTF_PACKAGE}::moving_window::extract_flag`,
    arguments: [tx.object('0x6')],
  });

  tx.transferObjects([flag], address);

  const result = await client.signAndExecuteTransaction({ transaction: tx, signer: keypair });
  console.log('Flag captured!', result);
})();