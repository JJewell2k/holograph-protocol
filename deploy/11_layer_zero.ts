declare var global: any;
import fs from 'fs';
import { BytesLike, ContractFactory, Contract } from 'ethers';
import { HardhatRuntimeEnvironment } from 'hardhat/types';
import { DeployFunction } from '@holographxyz/hardhat-deploy-holographed/types';
import { LeanHardhatRuntimeEnvironment, hreSplit, zeroAddress } from '../scripts/utils/helpers';
import { NetworkType, networks } from '@holographxyz/networks';
import { SuperColdStorageSigner } from 'super-cold-storage-signer';

const func: DeployFunction = async function (hre1: HardhatRuntimeEnvironment) {
  let { hre, hre2 } = await hreSplit(hre1, global.__companionNetwork);
  const accounts = await hre.ethers.getSigners();
  let deployer: SignerWithAddress | SuperColdStorageSigner = accounts[0];

  if (global.__superColdStorage) {
    // address, domain, authorization, ca
    const coldStorage = global.__superColdStorage;
    deployer = new SuperColdStorageSigner(
      coldStorage.address,
      'https://' + coldStorage.domain,
      coldStorage.authorization,
      deployer.provider,
      coldStorage.ca
    );
  }

  const salt = hre.deploymentSalt;

  const currentNetworkType: NetworkType = networks[hre.networkName].type;

  let lzEndpoint = networks[hre.networkName].lzEndpoint.toLowerCase();
  if (currentNetworkType == NetworkType.local && lzEndpoint == zeroAddress) {
    lzEndpoint = (await hre.getNamedAccounts()).lzEndpoint;
    const mockLZEndpoint = await hre.deployments.deploy('MockLZEndpoint', {
      from: lzEndpoint,
      args: [],
      log: true,
      waitConfirmations: 1,
      nonce: await hre.ethers.provider.getTransactionCount(lzEndpoint),
    });
    lzEndpoint = mockLZEndpoint.address.toLowerCase();
  }

  const error = function (err: string) {
    hre.deployments.log(err);
    process.exit();
  };

  const layerZeroModule = await hre.ethers.getContract('LayerZeroModule', deployer);

  if ((await layerZeroModule.getLZEndpoint()).toLowerCase() != lzEndpoint) {
    const lzTx = await layerZeroModule
      .setLZEndpoint(lzEndpoint, { nonce: await hre.ethers.provider.getTransactionCount(deployer.address) })
      .catch(error);
    hre.deployments.log('Transaction hash:', lzTx.hash);
    await lzTx.wait();
    hre.deployments.log(`Registered lzEndpoint to: ${await layerZeroModule.getLZEndpoint()}`);
  } else {
    hre.deployments.log(`lzEndpoint is already registered to: ${await layerZeroModule.getLZEndpoint()}`);
  }
};

export default func;
func.tags = ['MockLZEndpoint', 'LayerZero'];
func.dependencies = ['HolographGenesis', 'DeploySources', 'LayerZeroModule'];
