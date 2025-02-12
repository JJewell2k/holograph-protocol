declare var global: any;
import fs from 'fs';
import '@typechain/hardhat';
import 'hardhat-gas-reporter';
import '@holographxyz/hardhat-deploy-holographed';
import '@nomiclabs/hardhat-waffle';
import '@nomiclabs/hardhat-ethers';
import '@nomiclabs/hardhat-etherscan';
import { types, task, HardhatUserConfig } from 'hardhat/config';
import '@holographxyz/hardhat-holograph-contract-builder';
import { Environment, getEnvironment } from '@holographxyz/environment';
import { NetworkType, Network, Networks, networks } from '@holographxyz/networks';
import dotenv from 'dotenv';
dotenv.config();

function hex2buffer(input: string): Uin8Array {
  input = input.toLowerCase().trim();
  if (input.startsWith('0x')) {
    input = input.substring(2).trim();
  }
  if (input.length % 2 !== 0) {
    input = '0' + input;
  }
  let bytes: number[] = [];
  for (let i = 0; i < input.length; i += 2) {
    bytes.push(parseInt(input.substring(i, i + 2), 16));
  }
  return Uint8Array.from(bytes);
}

const currentEnvironment = Environment[getEnvironment()];
process.stdout.write(`\n👉 Environment: ${currentEnvironment}\n\n`);

const SOLIDITY_VERSION = process.env.SOLIDITY_VERSION || '0.8.13';

const MNEMONIC = process.env.MNEMONIC || 'test '.repeat(11) + 'junk';
const DEPLOYER = process.env.DEPLOYER || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

if (process.env.SUPER_COLD_STORAGE_ENABLED && process.env.SUPER_COLD_STORAGE_ENABLED == 'true') {
  global.__superColdStorage = {
    address: process.env.SUPER_COLD_STORAGE_ADDRESS,
    domain: process.env.SUPER_COLD_STORAGE_DOMAIN,
    authorization: process.env.SUPER_COLD_STORAGE_AUTHORIZATION, //String.fromCharCode.apply(null, hex2buffer(process.env.SUPER_COLD_STORAGE_AUTHORIZATION)),
    ca: String.fromCharCode.apply(null, hex2buffer(process.env.SUPER_COLD_STORAGE_CA)),
  };
}

const setDeployerKey = function (fallbackKey: string | number): string | number {
  if ('__superColdStorage' in global) {
    return ('super-cold-storage://' + global.__superColdStorage.address) as string;
  } else {
    return fallbackKey;
  }
};

const AVALANCHE_PRIVATE_KEY = process.env.AVALANCHE_PRIVATE_KEY || DEPLOYER;
const AVALANCHE_TESTNET_PRIVATE_KEY = process.env.AVALANCHE_TESTNET_PRIVATE_KEY || DEPLOYER;
const BINANCE_SMART_CHAIN_PRIVATE_KEY = process.env.BINANCE_SMART_CHAIN_PRIVATE_KEY || DEPLOYER;
const BINANCE_SMART_CHAIN_TESTNET_PRIVATE_KEY = process.env.BINANCE_SMART_CHAIN_TESTNET_PRIVATE_KEY || DEPLOYER;
const ETHEREUM_PRIVATE_KEY = process.env.ETHEREUM_PRIVATE_KEY || DEPLOYER;
const ETHEREUM_TESTNET_GOERLI_PRIVATE_KEY = process.env.ETHEREUM_TESTNET_GOERLI_PRIVATE_KEY || DEPLOYER;
const ETHEREUM_TESTNET_RINKEBY_PRIVATE_KEY = process.env.ETHEREUM_TESTNET_RINKEBY_PRIVATE_KEY || DEPLOYER;
const POLYGON_PRIVATE_KEY = process.env.POLYGON_PRIVATE_KEY || DEPLOYER;
const POLYGON_TESTNET_PRIVATE_KEY = process.env.POLYGON_TESTNET_PRIVATE_KEY || DEPLOYER;

const ETHERSCAN_API_KEY: string = process.env.ETHERSCAN_API_KEY || '';
const POLYGONSCAN_API_KEY: string = process.env.POLYGONSCAN_API_KEY || '';
const AVALANCHE_API_KEY: string = process.env.AVALANCHE_API_KEY || '';

const selectDeploymentSalt = (): number => {
  let salt;
  switch (currentEnvironment) {
    case Environment.experimental:
      salt = parseInt(process.env.EXPERIMENTAL_DEPLOYMENT_SALT || '1000000');
      if (salt > 9999999 || salt < 1000000) {
        throw new Error('EXPERIMENTAL_DEPLOYMENT_SALT is out of bounds. Allowed range is [1000000-9999999]');
      }
      break;
    case Environment.develop:
      salt = parseInt(process.env.DEVELOP_DEPLOYMENT_SALT || '1000');
      if (salt > 999999 || salt < 1000) {
        throw new Error('DEVELOP_DEPLOYMENT_SALT is out of bounds. Allowed range is [1000-999999]');
      }
      break;
    case Environment.testnet:
      salt = parseInt(process.env.TESTNET_DEPLOYMENT_SALT || '0');
      if (salt > 999 || salt < 0) {
        throw new Error('TESTNET_DEPLOYMENT_SALT is out of bounds. Allowed range is [0-999]');
      }
      break;
    case Environment.mainnet:
      salt = parseInt(process.env.MAINNET_DEPLOYMENT_SALT || '0');
      if (salt > 999 || salt < 0) {
        throw new Error('MAINNET_DEPLOYMENT_SALT is out of bounds. Allowed range is [0-999]');
      }
      break;
    default:
      throw new Error('Unknown Environment provided -> ' + currentEnvironment);
  }
  return salt;
};

const DEPLOYMENT_SALT = selectDeploymentSalt();

const DEPLOYMENT_PATH = process.env.DEPLOYMENT_PATH || 'deployments';

global.__DEPLOYMENT_SALT = '0x' + DEPLOYMENT_SALT.toString(16).padStart(64, '0');

task('abi', 'Create standalone ABI files for all smart contracts')
  .addOptionalParam('silent', 'Provide less details in the output', false, types.boolean)
  .setAction(async (args, hre) => {
    if (!fs.existsSync('./artifacts')) {
      throw new Error('The directory "artifacts" was not found. Make sure you run "yarn compile" first.');
    }
    const recursiveDelete = function (dir: string) {
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (let i = 0, l = files.length; i < l; i++) {
        if (files[i].isDirectory()) {
          recursiveDelete(dir + '/' + files[i].name);
          fs.rmdirSync(dir + '/' + files[i].name);
        } else {
          fs.unlinkSync(dir + '/' + files[i].name);
        }
      }
    };
    const extractABIs = function (sourceDir: string, deployDir: string) {
      const files = fs.readdirSync(sourceDir, { withFileTypes: true });
      for (let i = 0, l = files.length; i < l; i++) {
        const file = files[i].name;
        if (files[i].isDirectory()) {
          extractABIs(sourceDir + '/' + file, deployDir);
        } else {
          if (file.endsWith('.json') && !file.endsWith('.dbg.json')) {
            if (!args.silent) {
              console.log(' -- exporting', file.split('.')[0], 'ABI');
            }
            const data = JSON.parse(fs.readFileSync(sourceDir + '/' + file, 'utf8')).abi;
            fs.writeFileSync(deployDir + '/' + file, JSON.stringify(data, undefined, 2));
          }
        }
      }
    };
    if (!fs.existsSync('./abi')) {
      fs.mkdirSync('./abi');
    }
    if (!fs.existsSync('./abi/' + currentEnvironment)) {
      fs.mkdirSync('./abi/' + currentEnvironment);
    } else {
      recursiveDelete('./abi/' + currentEnvironment);
    }
    extractABIs('./artifacts/contracts', './abi/' + currentEnvironment);
  });

/**
 * Go to https://hardhat.org/config/ to learn more
 * @type import('hardhat/config').HardhatUserConfig
 */
const config: HardhatUserConfig = {
  paths: {
    deployments: DEPLOYMENT_PATH + '/' + currentEnvironment,
  },
  defaultNetwork: 'localhost',
  external: {
    deployments: {
      arbitrum: [DEPLOYMENT_PATH + '/external/arbitrum'],
      arbitrumTestnetRinkeby: [DEPLOYMENT_PATH + '/external/arbitrumTestnetRinkeby'],
      aurora: [DEPLOYMENT_PATH + '/external/aurora'],
      auroraTestnet: [DEPLOYMENT_PATH + '/external/auroraTestnet'],
      avalanche: [DEPLOYMENT_PATH + '/external/avalanche'],
      avalancheTestnet: [DEPLOYMENT_PATH + '/external/avalancheTestnet'],
      binanceSmartChain: [DEPLOYMENT_PATH + '/external/binanceSmartChain'],
      binanceSmartChainTestnet: [DEPLOYMENT_PATH + '/external/binanceSmartChainTestnet'],
      cronos: [DEPLOYMENT_PATH + '/external/cronos'],
      cronosTestnet: [DEPLOYMENT_PATH + '/external/cronosTestnet'],
      ethereum: [DEPLOYMENT_PATH + '/external/ethereum'],
      ethereumTestnetGoerli: [DEPLOYMENT_PATH + '/external/ethereumTestnetGoerli'],
      ethereumTestnetKovan: [DEPLOYMENT_PATH + '/external/ethereumTestnetKovan'],
      ethereumTestnetRinkeby: [DEPLOYMENT_PATH + '/external/ethereumTestnetRinkeby'],
      ethereumTestnetRopsten: [DEPLOYMENT_PATH + '/external/ethereumTestnetRopsten'],
      fantom: [DEPLOYMENT_PATH + '/external/fantom'],
      fantomTestnet: [DEPLOYMENT_PATH + '/external/fantomTestnet'],
      gnosis: [DEPLOYMENT_PATH + '/external/gnosis'],
      gnosisTestnetSokol: [DEPLOYMENT_PATH + '/external/gnosisTestnetSokol'],
      localhost: [DEPLOYMENT_PATH + '/external/localhost'],
      localhost2: [DEPLOYMENT_PATH + '/external/localhost2'],
      optimism: [DEPLOYMENT_PATH + '/external/optimism'],
      optimismTestnetKovan: [DEPLOYMENT_PATH + '/external/optimismTestnetKovan'],
      polygon: [DEPLOYMENT_PATH + '/external/polygon'],
      polygonTestnet: [DEPLOYMENT_PATH + '/external/polygonTestnet'],
    },
  },
  networks: {
    localhost: {
      url: networks.localhost.rpc,
      chainId: networks.localhost.chain,
      accounts: {
        mnemonic: MNEMONIC,
        path: "m/44'/60'/0'/0",
        initialIndex: 0,
        count: 11,
        passphrase: '',
      },
      companionNetworks: {
        // https://github.com/wighawag/hardhat-deploy#companionnetworks
        l2: 'localhost2',
      },
      saveDeployments: false,
    },
    localhost2: {
      url: networks.localhost2.rpc,
      chainId: networks.localhost2.chain,
      accounts: {
        mnemonic: MNEMONIC,
        path: "m/44'/60'/0'/0",
        initialIndex: 0,
        count: 11,
        passphrase: '',
      },
      companionNetworks: {
        // https://github.com/wighawag/hardhat-deploy#companionnetworks
        l2: 'localhost',
      },
      saveDeployments: false,
    },
    avalanche: {
      url: networks.avalanche.rpc,
      chainId: networks.avalanche.chain,
      accounts: [AVALANCHE_PRIVATE_KEY],
    },
    avalancheTestnet: {
      url: networks.avalancheTestnet.rpc,
      chainId: networks.avalancheTestnet.chain,
      accounts: [AVALANCHE_TESTNET_PRIVATE_KEY],
    },
    binanceSmartChain: {
      url: networks.binanceSmartChain.rpc,
      chainId: networks.binanceSmartChain.chain,
      accounts: [BINANCE_SMART_CHAIN_PRIVATE_KEY],
    },
    binanceSmartChainTestnet: {
      url: networks.binanceSmartChainTestnet.rpc,
      chainId: networks.binanceSmartChainTestnet.chain,
      accounts: [BINANCE_SMART_CHAIN_TESTNET_PRIVATE_KEY],
    },
    ethereum: {
      url: networks.ethereum.rpc,
      chainId: networks.ethereum.chain,
      accounts: [ETHEREUM_PRIVATE_KEY],
    },
    ethereumTestnetRinkeby: {
      url: networks.ethereumTestnetRinkeby.rpc,
      chainId: networks.ethereumTestnetRinkeby.chain,
      accounts: [ETHEREUM_TESTNET_RINKEBY_PRIVATE_KEY],
    },
    ethereumTestnetGoerli: {
      url: networks.ethereumTestnetGoerli.rpc,
      chainId: networks.ethereumTestnetGoerli.chain,
      accounts: [ETHEREUM_TESTNET_GOERLI_PRIVATE_KEY],
    },
    polygon: {
      url: networks.polygon.rpc,
      chainId: networks.polygon.chain,
      accounts: [POLYGON_PRIVATE_KEY],
    },
    polygonTestnet: {
      url: networks.polygonTestnet.rpc,
      chainId: networks.polygonTestnet.chain,
      accounts: [POLYGON_TESTNET_PRIVATE_KEY],
    },
    coverage: {
      url: 'http://127.0.0.1:8555',
    },
  },
  namedAccounts: {
    deployer: setDeployerKey(0),
    lzEndpoint: 10,
  },
  solidity: {
    version: SOLIDITY_VERSION,
    settings: {
      optimizer: {
        enabled: true,
        runs: 999999,
      },
      metadata: {
        bytecodeHash: 'none',
      },
    },
  },
  mocha: {
    timeout: 1000 * 60 * 60,
  },
  gasReporter: {
    // I prefer my command line tools to not try to connect to a 3rd party site while I am loading private keys into it
    enabled: process.env.PRIVACY_MODE ? false : true,
    // enabled: process.env.COINMARKETCAP_API_KEY !== undefined,
    outputFile: './gasReport.txt', // comment line to get the report on terminal
    noColors: true, // comment line to get the report on terminal
    currency: 'USD',
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || '',
    token: 'ETH',
    gasPriceApi: 'https://api.binanceSmartChainscan.com/api?module=proxy&action=ethereumTestnet_gasPrice',
  },
  etherscan: {
    apiKey: {
      mainnet: ETHERSCAN_API_KEY,
      rinkeby: ETHERSCAN_API_KEY,
      goerli: ETHERSCAN_API_KEY,
      polygon: POLYGONSCAN_API_KEY,
      polygonMumbai: POLYGONSCAN_API_KEY,
      avalanche: AVALANCHE_API_KEY,
      avalancheFujiTestnet: AVALANCHE_API_KEY,
    },
  },
  hardhatHolographContractBuilder: {
    runOnCompile: true,
    verbose: false,
  },
};

export default config;
