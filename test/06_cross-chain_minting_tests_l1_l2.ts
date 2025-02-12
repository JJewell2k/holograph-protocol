declare var global: any;
import Web3 from 'web3';
import { AbiItem } from 'web3-utils';
import { expect, assert } from 'chai';
import { PreTest } from './utils';
import setup from './utils';
import { BigNumberish, BytesLike, BigNumber, ContractFactory } from 'ethers';
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/signers';
import {
  Signature,
  StrictECDSA,
  zeroAddress,
  functionHash,
  XOR,
  hexToBytes,
  stringToHex,
  buildDomainSeperator,
  randomHex,
  generateInitCode,
  generateErc20Config,
  generateErc721Config,
  LeanHardhatRuntimeEnvironment,
  getGasUsage,
  remove0x,
  KeyOf,
  HASH,
  executeJobGas,
  adminCall,
} from '../scripts/utils/helpers';
import {
  HolographERC20Event,
  HolographERC721Event,
  HolographERC1155Event,
  ConfigureEvents,
} from '../scripts/utils/events';
import ChainId from '../scripts/utils/chain';
import {
  Admin,
  CxipERC721,
  ERC20Mock,
  Holograph,
  HolographBridge,
  HolographBridgeProxy,
  Holographer,
  HolographERC20,
  HolographERC721,
  HolographFactory,
  HolographFactoryProxy,
  HolographGenesis,
  HolographRegistry,
  HolographRegistryProxy,
  HToken,
  HolographUtilityToken,
  HolographInterfaces,
  MockERC721Receiver,
  Owner,
  HolographRoyalties,
  SampleERC20,
  SampleERC721,
} from '../typechain-types';
import { DeploymentConfigStruct } from '../typechain-types/HolographFactory';
import { GasParametersStructOutput } from '../typechain-types/LayerZeroModule';

const hValueTrim = function (inputPayload: string | BytesLike): BytesLike {
  let index = 2 + 4 * 2 + 32 * 2 * 5; // 0x + functionSig + data
  let payload: string = inputPayload as string;
  return payload.slice(0, index) + '00'.repeat(32) + payload.slice(index + 32 * 2, payload.length);
};

const BLOCKTIME: number = 60;
const GWEI: BigNumber = BigNumber.from('1000000000');
const TESTGASLIMIT: BigNumber = BigNumber.from('10000000');
const GASPRICE: BigNumber = BigNumber.from('1000000000');

function shuffleWallets(array: KeyOf<PreTest>[]) {
  let currentIndex = array.length,
    randomIndex;

  // While there remain elements to shuffle.
  while (currentIndex != 0) {
    // Pick a remaining element.
    randomIndex = Math.floor(Math.random() * currentIndex);
    currentIndex--;

    // And swap it with the current element.
    [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
  }

  return array;
}

describe('Testing cross-chain minting (L1 & L2)', async function () {
  let l1: PreTest;
  let l2: PreTest;

  let HLGL1: HolographERC20;
  let HLGL2: HolographERC20;

  let gasParameters: GasParametersStructOutput;
  let msgBaseGas: BigNumber;
  let msgGasPerByte: BigNumber;
  let jobBaseGas: BigNumber;
  let jobGasPerByte: BigNumber;

  let wallets: KeyOf<PreTest>[];

  let pickOperator = function (chain: PreTest, target: string, opposite: boolean = false): SignerWithAddress {
    let operator: SignerWithAddress = chain.deployer;
    let targetOperator = target.toLowerCase();
    if (targetOperator != zeroAddress) {
      let wallet: SignerWithAddress;
      // shuffle
      shuffleWallets(wallets);
      for (let i = 0, l = wallets.length; i < l; i++) {
        wallet = chain[wallets[i]] as SignerWithAddress;
        if (
          (!opposite && wallet.address.toLowerCase() == targetOperator) ||
          (opposite && wallet.address.toLowerCase() != targetOperator)
        ) {
          operator = wallet;
          break;
        }
      }
    }
    return operator;
  };

  let getLzMsgGas = function (payload: string): BigNumber {
    return msgBaseGas.add(BigNumber.from(Math.floor((payload.length - 2) / 2)).mul(msgGasPerByte));
  };

  let getHlgMsgGas = function (gasLimit: BigNmber, payload: string): BigNumber {
    return gasLimit.add(jobBaseGas.add(BigNumber.from(Math.floor((payload.length - 2) / 2)).mul(jobGasPerByte)));
  };

  let getRequestPayload = async function (
    l1: PreTest,
    l2: PreTest,
    target: string | BytesLike,
    data: string | BytesLike
  ): Promise<BytesLike> {
    let payload: BytesLike = await l1.bridge
      .connect(l1.deployer)
      .callStatic.getBridgeOutRequestPayload(
        l2.network.holographId,
        target as string,
        '0x' + 'ff'.repeat(32),
        '0x' + 'ff'.repeat(32),
        data as string
      );
    return payload;
  };

  let getEstimatedGas = async function (
    l1: PreTest,
    l2: PreTest,
    target: string | BytesLike,
    data: string | BytesLike,
    payload: string | BytesLike
  ): Promise<{
    payload: string;
    estimatedGas: BigNumber;
    fee: BigNumber;
    hlgFee: BigNumber;
    msgFee: BigNumber;
    dstGasPrice: BigNumber;
  }> {
    let estimatedGas: BigNumber = TESTGASLIMIT.sub(
      await l2.operator.callStatic.jobEstimator(payload as string, {
        gasPrice: GASPRICE,
        gasLimit: TESTGASLIMIT,
      })
    );

    payload = await l1.bridge
      .connect(l1.deployer)
      .callStatic.getBridgeOutRequestPayload(
        l2.network.holographId,
        target as string,
        estimatedGas,
        GWEI,
        data as string
      );

    let fees = await l1.bridge.callStatic.getMessageFee(l2.network.holographId, estimatedGas, GWEI, payload);
    let total: BigNumber = fees[0].add(fees[1]);
    estimatedGas = TESTGASLIMIT.sub(
      await l2.operator.callStatic.jobEstimator(payload as string, {
        value: total,
        gasPrice: GASPRICE,
        gasLimit: TESTGASLIMIT,
      })
    );
    estimatedGas = getHlgMsgGas(estimatedGas, payload);
    return { payload, estimatedGas, fee: total, hlgFee: fees[0], msgFee: fees[1], dstGasPrice: fees[2] };
  };

  let totalNFTs: number = 2;
  let firstNFTl1: BigNumber = BigNumber.from(1);
  let firstNFTl2: BigNumber = BigNumber.from(1);
  let secondNFTl1: BigNumber = BigNumber.from(2);
  let secondNFTl2: BigNumber = BigNumber.from(2);
  let thirdNFTl1: BigNumber = BigNumber.from(3);
  let thirdNFTl2: BigNumber = BigNumber.from(3);

  let payloadThirdNFTl1: BytesLike;
  let payloadThirdNFTl2: BytesLike;

  let contractName: string = 'Sample ERC721 Contract ';
  let contractSymbol: string = 'SMPLR';
  const contractBps: number = 1000;
  const contractImage: string = '';
  const contractExternalLink: string = '';
  const tokenURIs: string[] = [
    'undefined',
    'https://holograph.xyz/sample1.json',
    'https://holograph.xyz/sample2.json',
    'https://holograph.xyz/sample3.json',
  ];
  // let l1ContractName = contractName + '(' + l1.hre.networkName + ')';
  // let l2ContractName = contractName + '(' + l2.hre.networkName + ')';
  let gasUsage: {
    [key: string]: BigNumber;
  } = {};

  before(async function () {
    l1 = await setup();
    l2 = await setup(true);

    gasParameters = await l1.lzModule.getGasParameters(l1.network.holographId);

    msgBaseGas = gasParameters.msgBaseGas;
    msgGasPerByte = gasParameters.msgGasPerByte;
    jobBaseGas = gasParameters.jobBaseGas;
    jobGasPerByte = gasParameters.jobGasPerByte;

    HLGL1 = await l1.holographErc20.attach(l1.utilityTokenHolographer.address);
    HLGL2 = await l2.holographErc20.attach(l2.utilityTokenHolographer.address);

    wallets = [
      'wallet1',
      'wallet2',
      'wallet3',
      'wallet4',
      'wallet5',
      'wallet6',
      'wallet7',
      'wallet8',
      'wallet9',
      'wallet10',
    ];

    firstNFTl2 = BigNumber.from('0x' + l2.network.holographId.toString(16).padStart(8, '0') + '00'.repeat(28)).add(
      firstNFTl1
    );
    secondNFTl2 = BigNumber.from('0x' + l2.network.holographId.toString(16).padStart(8, '0') + '00'.repeat(28)).add(
      secondNFTl1
    );
    thirdNFTl2 = BigNumber.from('0x' + l2.network.holographId.toString(16).padStart(8, '0') + '00'.repeat(28)).add(
      thirdNFTl1
    );

    gasUsage['#3 bridge from l1'] = BigNumber.from(0);
    gasUsage['#3 bridge from l2'] = BigNumber.from(0);
    gasUsage['#1 mint on l1'] = BigNumber.from(0);
    gasUsage['#1 mint on l2'] = BigNumber.from(0);

    payloadThirdNFTl1 =
      functionHash('bridgeInRequest(uint256,uint32,address,address,address,uint256,bytes)') +
      generateInitCode(
        ['uint256', 'uint32', 'address', 'address', 'address', 'uint256', 'bytes'],
        [
          0, // nonce
          l1.network.holographId, // fromChain
          l1.sampleErc721Holographer.address, // holographableContract
          l1.hTokenHolographer.address, // hToken
          zeroAddress, // hTokenRecipient
          0, // hTokenValue
          generateInitCode(
            ['address', 'address', 'uint256', 'bytes'],
            [
              l1.deployer.address, // from
              l2.deployer.address, // to
              thirdNFTl1.toHexString(), // tokenId
              generateInitCode(['bytes'], [hexToBytes(stringToHex(tokenURIs[3]))]), // data
            ]
          ), // data
        ]
      ).substring(2);

    payloadThirdNFTl2 =
      functionHash('erc721in(uint32,address,address,address,uint256,bytes)') +
      generateInitCode(
        ['uint32', 'address', 'address', 'address', 'uint256', 'bytes'],
        [
          l2.network.holographId,
          l1.sampleErc721Holographer.address,
          l2.deployer.address,
          l1.deployer.address,
          thirdNFTl2.toHexString(),
          generateInitCode(['bytes'], [hexToBytes(stringToHex(tokenURIs[3]))]),
        ]
      ).substring(2);

    // we need to balance wallets from l1 and l2
    let noncel1 = await l1.deployer.getTransactionCount();
    let noncel2 = await l2.deployer.getTransactionCount();
    let target = Math.max(noncel1, noncel2) - Math.min(noncel1, noncel2);
    let balancer = noncel1 > noncel2 ? l2.deployer : l1.deployer;
    for (let i = 0; i < target; i++) {
      let tx = await balancer.sendTransaction({
        to: balancer.address,
        value: '0x0000000000000000000000000000000000000000000000000000000000000000',
      });
      await tx.wait();
    }
  });

  after(async function () {});

  beforeEach(async function () {});

  afterEach(async function () {});

  describe('Enable operators for l1 and l2', async function () {
    it('should add 10 operator wallets for each chain', async function () {
      let bondAmounts: BigNumber[] = await l1.operator.getPodBondAmounts(1);
      let bondAmount: BigNumber = bondAmounts[0];
      process.stdout.write('\n' + ' '.repeat(6) + 'bondAmount: ' + bondAmount.toString() + '\n');
      //      process.stdout.write('\n' + 'currentBalance l1: ' + (await HLGL1.connect(l1.deployer).balanceOf(l1.deployer.address)).toString());
      //      process.stdout.write('\n' + 'currentBalance l2: ' + (await HLGL2.connect(l2.deployer).balanceOf(l2.deployer.address)).toString() + '\n');
      for (let i = 0, l = wallets.length; i < l; i++) {
        let l1wallet: SignerWithAddress = l1[wallets[i]] as SignerWithAddress;
        let l2wallet: SignerWithAddress = l2[wallets[i]] as SignerWithAddress;
        //        process.stdout.write('working on wallet: ' + l1wallet.address + '\n');
        await HLGL1.connect(l1.deployer).transfer(l1wallet.address, bondAmount);
        await HLGL1.connect(l1wallet).approve(l1.operator.address, bondAmount);
        await expect(l1.operator.connect(l1wallet).bondUtilityToken(l1wallet.address, bondAmount, 1)).to.not.be
          .reverted;
        await HLGL2.connect(l2.deployer).transfer(l2wallet.address, bondAmount);
        await HLGL2.connect(l2wallet).approve(l2.operator.address, bondAmount);
        await expect(l2.operator.connect(l2wallet).bondUtilityToken(l2wallet.address, bondAmount, 1)).to.not.be
          .reverted;
        //        process.stdout.write('finished wallet: ' + l2wallet.address + '\n');
      }
    });
  });

  describe('Deploy cross-chain contracts via bridge deploy', async function () {
    describe('hToken', async function () {
      it('deploy l1 equivalent on l2', async function () {
        let { erc20Config, erc20ConfigHash, erc20ConfigHashBytes } = await generateErc20Config(
          l1.network,
          l1.deployer.address,
          'hToken',
          l1.network.tokenName + ' (Holographed #' + l1.network.holographId.toString() + ')',
          'h' + l1.network.tokenSymbol,
          l1.network.tokenName + ' (Holographed #' + l1.network.holographId.toString() + ')',
          '1',
          18,
          ConfigureEvents([]),
          generateInitCode(['address', 'uint16'], [l1.deployer.address, 0]),
          l1.salt
        );

        let hTokenErc20Address = await l2.registry.getHolographedHashAddress(erc20ConfigHash);

        expect(hTokenErc20Address).to.equal(zeroAddress);

        hTokenErc20Address = await l1.registry.getHolographedHashAddress(erc20ConfigHash);

        let sig = await l1.deployer.signMessage(erc20ConfigHashBytes);
        let signature: Signature = StrictECDSA({
          r: '0x' + sig.substring(2, 66),
          s: '0x' + sig.substring(66, 130),
          v: '0x' + sig.substring(130, 132),
        } as Signature);

        let data: BytesLike = generateInitCode(
          ['tuple(bytes32,uint32,bytes32,bytes,bytes)', 'tuple(bytes32,bytes32,uint8)', 'address'],
          [
            [
              erc20Config.contractType,
              erc20Config.chainType,
              erc20Config.salt,
              erc20Config.byteCode,
              erc20Config.initCode,
            ],
            [signature.r, signature.s, signature.v],
            l1.deployer.address,
          ]
        );

        let originalMessagingModule = await l2.operator.getMessagingModule();
        let payload: BytesLike = hValueTrim(await getRequestPayload(l1, l2, l1.factory.address, data));
        let gasEstimates = await getEstimatedGas(l1, l2, l1.factory.address, data, payload);
        payload = hValueTrim(gasEstimates.payload);
        let payloadHash: string = HASH(payload);
        // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
        await l2.operator.setMessagingModule(l2.mockLZEndpoint.address);
        // make call with mockLZEndpoint AS messaging module
        await l2.mockLZEndpoint.crossChainMessage(l2.operator.address, getLzMsgGas(payload), payload, {
          gasLimit: TESTGASLIMIT,
        });
        // return messaging module back to original address
        await l2.operator.setMessagingModule(originalMessagingModule);
        let operatorJob = await l2.operator.getJobDetails(payloadHash);
        let operator = (operatorJob[2] as string).toLowerCase();
        // execute job to leave operator bonded
        await expect(
          l2.operator.connect(pickOperator(l2, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
        )
          .to.emit(l2.factory, 'BridgeableContractDeployed')
          .withArgs(hTokenErc20Address, erc20ConfigHash);
        expect(await l2.registry.getHolographedHashAddress(erc20ConfigHash)).to.equal(hTokenErc20Address);
      });

      it('deploy l2 equivalent on l1', async function () {
        let { erc20Config, erc20ConfigHash, erc20ConfigHashBytes } = await generateErc20Config(
          l2.network,
          l2.deployer.address,
          'hToken',
          l2.network.tokenName + ' (Holographed #' + l2.network.holographId.toString() + ')',
          'h' + l2.network.tokenSymbol,
          l2.network.tokenName + ' (Holographed #' + l2.network.holographId.toString() + ')',
          '1',
          18,
          ConfigureEvents([]),
          generateInitCode(['address', 'uint16'], [l2.deployer.address, 0]),
          l2.salt
        );

        let hTokenErc20Address = await l1.registry.getHolographedHashAddress(erc20ConfigHash);

        expect(hTokenErc20Address).to.equal(zeroAddress);

        hTokenErc20Address = await l2.registry.getHolographedHashAddress(erc20ConfigHash);

        let sig = await l2.deployer.signMessage(erc20ConfigHashBytes);
        let signature: Signature = StrictECDSA({
          r: '0x' + sig.substring(2, 66),
          s: '0x' + sig.substring(66, 130),
          v: '0x' + sig.substring(130, 132),
        } as Signature);

        let data: BytesLike = generateInitCode(
          ['tuple(bytes32,uint32,bytes32,bytes,bytes)', 'tuple(bytes32,bytes32,uint8)', 'address'],
          [
            [
              erc20Config.contractType,
              erc20Config.chainType,
              erc20Config.salt,
              erc20Config.byteCode,
              erc20Config.initCode,
            ],
            [signature.r, signature.s, signature.v],
            l2.deployer.address,
          ]
        );

        let originalMessagingModule = await l1.operator.getMessagingModule();
        let payload: BytesLike = hValueTrim(await getRequestPayload(l2, l1, l2.factory.address, data));
        let gasEstimates = await getEstimatedGas(l2, l1, l2.factory.address, data, payload);
        payload = hValueTrim(gasEstimates.payload);
        let payloadHash: string = HASH(payload);
        // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
        await l1.operator.setMessagingModule(l1.mockLZEndpoint.address);
        // make call with mockLZEndpoint AS messaging module
        await l1.mockLZEndpoint.crossChainMessage(l1.operator.address, getLzMsgGas(payload), payload, {
          gasLimit: TESTGASLIMIT,
        });
        // return messaging module back to original address
        await l1.operator.setMessagingModule(originalMessagingModule);
        let operatorJob = await l1.operator.getJobDetails(payloadHash);
        let operator = (operatorJob[2] as string).toLowerCase();
        // execute job to leave operator bonded
        await expect(
          l1.operator.connect(pickOperator(l1, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
        )
          .to.emit(l1.factory, 'BridgeableContractDeployed')
          .withArgs(hTokenErc20Address, erc20ConfigHash);
        expect(await l1.registry.getHolographedHashAddress(erc20ConfigHash)).to.equal(hTokenErc20Address);
      });
    });

    describe('SampleERC20', async function () {
      it('deploy l1 equivalent on l2', async function () {
        let { erc20Config, erc20ConfigHash, erc20ConfigHashBytes } = await generateErc20Config(
          l1.network,
          l1.deployer.address,
          'SampleERC20',
          'Sample ERC20 Token (' + l1.hre.networkName + ')',
          'SMPL',
          'Sample ERC20 Token',
          '1',
          18,
          ConfigureEvents([HolographERC20Event.bridgeIn, HolographERC20Event.bridgeOut]),
          generateInitCode(['address', 'uint16'], [l1.deployer.address, 0]),
          l1.salt
        );

        let sampleErc20Address = await l2.registry.getHolographedHashAddress(erc20ConfigHash);

        expect(sampleErc20Address).to.equal(zeroAddress);

        sampleErc20Address = await l1.registry.getHolographedHashAddress(erc20ConfigHash);

        let sig = await l1.deployer.signMessage(erc20ConfigHashBytes);
        let signature: Signature = StrictECDSA({
          r: '0x' + sig.substring(2, 66),
          s: '0x' + sig.substring(66, 130),
          v: '0x' + sig.substring(130, 132),
        } as Signature);

        let data: BytesLike = generateInitCode(
          ['tuple(bytes32,uint32,bytes32,bytes,bytes)', 'tuple(bytes32,bytes32,uint8)', 'address'],
          [
            [
              erc20Config.contractType,
              erc20Config.chainType,
              erc20Config.salt,
              erc20Config.byteCode,
              erc20Config.initCode,
            ],
            [signature.r, signature.s, signature.v],
            l1.deployer.address,
          ]
        );

        let originalMessagingModule = await l2.operator.getMessagingModule();
        let payload: BytesLike = await getRequestPayload(l1, l2, l1.factory.address, data);
        let gasEstimates = await getEstimatedGas(l1, l2, l1.factory.address, data, payload);
        payload = gasEstimates.payload;
        let payloadHash: string = HASH(payload);
        // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
        await l2.operator.setMessagingModule(l2.mockLZEndpoint.address);
        // make call with mockLZEndpoint AS messaging module
        await l2.mockLZEndpoint.crossChainMessage(l2.operator.address, getLzMsgGas(payload), payload, {
          gasLimit: TESTGASLIMIT,
        });
        // return messaging module back to original address
        await l2.operator.setMessagingModule(originalMessagingModule);
        let operatorJob = await l2.operator.getJobDetails(payloadHash);
        let operator = (operatorJob[2] as string).toLowerCase();
        // execute job to leave operator bonded
        await expect(
          l2.operator.connect(pickOperator(l2, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
        )
          .to.emit(l2.factory, 'BridgeableContractDeployed')
          .withArgs(sampleErc20Address, erc20ConfigHash);
        expect(await l2.registry.getHolographedHashAddress(erc20ConfigHash)).to.equal(sampleErc20Address);
      });

      it('deploy l2 equivalent on l1', async function () {
        let { erc20Config, erc20ConfigHash, erc20ConfigHashBytes } = await generateErc20Config(
          l2.network,
          l2.deployer.address,
          'SampleERC20',
          'Sample ERC20 Token (' + l2.hre.networkName + ')',
          'SMPL',
          'Sample ERC20 Token',
          '1',
          18,
          ConfigureEvents([HolographERC20Event.bridgeIn, HolographERC20Event.bridgeOut]),
          generateInitCode(['address', 'uint16'], [l1.deployer.address, 0]),
          l2.salt
        );

        let sampleErc20Address = await l1.registry.getHolographedHashAddress(erc20ConfigHash);

        expect(sampleErc20Address).to.equal(zeroAddress);

        sampleErc20Address = await l2.registry.getHolographedHashAddress(erc20ConfigHash);

        let sig = await l2.deployer.signMessage(erc20ConfigHashBytes);
        let signature: Signature = StrictECDSA({
          r: '0x' + sig.substring(2, 66),
          s: '0x' + sig.substring(66, 130),
          v: '0x' + sig.substring(130, 132),
        } as Signature);

        let data: BytesLike = generateInitCode(
          ['tuple(bytes32,uint32,bytes32,bytes,bytes)', 'tuple(bytes32,bytes32,uint8)', 'address'],
          [
            [
              erc20Config.contractType,
              erc20Config.chainType,
              erc20Config.salt,
              erc20Config.byteCode,
              erc20Config.initCode,
            ],
            [signature.r, signature.s, signature.v],
            l2.deployer.address,
          ]
        );

        let originalMessagingModule = await l1.operator.getMessagingModule();
        let payload: BytesLike = await getRequestPayload(l2, l1, l2.factory.address, data);
        let gasEstimates = await getEstimatedGas(l2, l1, l2.factory.address, data, payload);
        payload = gasEstimates.payload;
        let payloadHash: string = HASH(payload);
        // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
        await l1.operator.setMessagingModule(l1.mockLZEndpoint.address);
        // make call with mockLZEndpoint AS messaging module
        await l1.mockLZEndpoint.crossChainMessage(l1.operator.address, getLzMsgGas(payload), payload, {
          gasLimit: TESTGASLIMIT,
        });
        // return messaging module back to original address
        await l1.operator.setMessagingModule(originalMessagingModule);
        let operatorJob = await l1.operator.getJobDetails(payloadHash);
        let operator = (operatorJob[2] as string).toLowerCase();
        // execute job to leave operator bonded
        await expect(
          l1.operator.connect(pickOperator(l1, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
        )
          .to.emit(l1.factory, 'BridgeableContractDeployed')
          .withArgs(sampleErc20Address, erc20ConfigHash);
        expect(await l1.registry.getHolographedHashAddress(erc20ConfigHash)).to.equal(sampleErc20Address);
      });
    });

    describe('SampleERC721', async function () {
      it('deploy l1 equivalent on l2', async function () {
        let { erc721Config, erc721ConfigHash, erc721ConfigHashBytes } = await generateErc721Config(
          l1.network,
          l1.deployer.address,
          'SampleERC721',
          'Sample ERC721 Contract (' + l1.hre.networkName + ')',
          'SMPLR',
          1000,
          ConfigureEvents([
            HolographERC721Event.bridgeIn,
            HolographERC721Event.bridgeOut,
            HolographERC721Event.afterBurn,
          ]),
          generateInitCode(['address'], [l1.deployer.address]),
          l1.salt
        );

        let sampleErc721Address = await l2.registry.getHolographedHashAddress(erc721ConfigHash);

        expect(sampleErc721Address).to.equal(zeroAddress);

        sampleErc721Address = await l1.registry.getHolographedHashAddress(erc721ConfigHash);

        let sig = await l1.deployer.signMessage(erc721ConfigHashBytes);
        let signature: Signature = StrictECDSA({
          r: '0x' + sig.substring(2, 66),
          s: '0x' + sig.substring(66, 130),
          v: '0x' + sig.substring(130, 132),
        } as Signature);

        let data: BytesLike = generateInitCode(
          ['tuple(bytes32,uint32,bytes32,bytes,bytes)', 'tuple(bytes32,bytes32,uint8)', 'address'],
          [
            [
              erc721Config.contractType,
              erc721Config.chainType,
              erc721Config.salt,
              erc721Config.byteCode,
              erc721Config.initCode,
            ],
            [signature.r, signature.s, signature.v],
            l1.deployer.address,
          ]
        );

        let originalMessagingModule = await l2.operator.getMessagingModule();
        let payload: BytesLike = await getRequestPayload(l1, l2, l1.factory.address, data);
        let gasEstimates = await getEstimatedGas(l1, l2, l1.factory.address, data, payload);
        payload = gasEstimates.payload;
        let payloadHash: string = HASH(payload);
        // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
        await l2.operator.setMessagingModule(l2.mockLZEndpoint.address);
        // make call with mockLZEndpoint AS messaging module
        await l2.mockLZEndpoint.crossChainMessage(l2.operator.address, getLzMsgGas(payload), payload, {
          gasLimit: TESTGASLIMIT,
        });
        // return messaging module back to original address
        await l2.operator.setMessagingModule(originalMessagingModule);
        let operatorJob = await l2.operator.getJobDetails(payloadHash);
        let operator = (operatorJob[2] as string).toLowerCase();
        // execute job to leave operator bonded
        await expect(
          l2.operator.connect(pickOperator(l2, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
        )
          .to.emit(l2.factory, 'BridgeableContractDeployed')
          .withArgs(sampleErc721Address, erc721ConfigHash);
        expect(await l2.registry.getHolographedHashAddress(erc721ConfigHash)).to.equal(sampleErc721Address);
      });

      it('deploy l2 equivalent on l1', async function () {
        let { erc721Config, erc721ConfigHash, erc721ConfigHashBytes } = await generateErc721Config(
          l2.network,
          l2.deployer.address,
          'SampleERC721',
          'Sample ERC721 Contract (' + l2.hre.networkName + ')',
          'SMPLR',
          1000,
          ConfigureEvents([
            HolographERC721Event.bridgeIn,
            HolographERC721Event.bridgeOut,
            HolographERC721Event.afterBurn,
          ]),
          generateInitCode(['address'], [l2.deployer.address]),
          l2.salt
        );

        let sampleErc721Address = await l1.registry.getHolographedHashAddress(erc721ConfigHash);

        expect(sampleErc721Address).to.equal(zeroAddress);

        sampleErc721Address = await l2.registry.getHolographedHashAddress(erc721ConfigHash);

        let sig = await l2.deployer.signMessage(erc721ConfigHashBytes);
        let signature: Signature = StrictECDSA({
          r: '0x' + sig.substring(2, 66),
          s: '0x' + sig.substring(66, 130),
          v: '0x' + sig.substring(130, 132),
        } as Signature);

        let data: BytesLike = generateInitCode(
          ['tuple(bytes32,uint32,bytes32,bytes,bytes)', 'tuple(bytes32,bytes32,uint8)', 'address'],
          [
            [
              erc721Config.contractType,
              erc721Config.chainType,
              erc721Config.salt,
              erc721Config.byteCode,
              erc721Config.initCode,
            ],
            [signature.r, signature.s, signature.v],
            l2.deployer.address,
          ]
        );

        let originalMessagingModule = await l1.operator.getMessagingModule();
        let payload: BytesLike = await getRequestPayload(l2, l1, l2.factory.address, data);
        let gasEstimates = await getEstimatedGas(l2, l1, l2.factory.address, data, payload);
        payload = gasEstimates.payload;
        let payloadHash: string = HASH(payload);
        // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
        await l1.operator.setMessagingModule(l1.mockLZEndpoint.address);
        // make call with mockLZEndpoint AS messaging module
        await l1.mockLZEndpoint.crossChainMessage(l1.operator.address, getLzMsgGas(payload), payload, {
          gasLimit: TESTGASLIMIT,
        });
        // return messaging module back to original address
        await l1.operator.setMessagingModule(originalMessagingModule);
        let operatorJob = await l1.operator.getJobDetails(payloadHash);
        let operator = (operatorJob[2] as string).toLowerCase();
        // execute job to leave operator bonded
        await expect(
          l1.operator.connect(pickOperator(l1, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
        )
          .to.emit(l1.factory, 'BridgeableContractDeployed')
          .withArgs(sampleErc721Address, erc721ConfigHash);
        expect(await l1.registry.getHolographedHashAddress(erc721ConfigHash)).to.equal(sampleErc721Address);
      });
    });

    describe('CxipERC721', async function () {
      it('deploy l1 equivalent on l2', async function () {
        let { erc721Config, erc721ConfigHash, erc721ConfigHashBytes } = await generateErc721Config(
          l1.network,
          l1.deployer.address,
          'CxipERC721Proxy',
          'CXIP ERC721 Collection (' + l1.hre.networkName + ')',
          'CXIP',
          1000,
          ConfigureEvents([
            HolographERC721Event.bridgeIn,
            HolographERC721Event.bridgeOut,
            HolographERC721Event.afterBurn,
          ]),
          generateInitCode(
            ['bytes32', 'address', 'bytes'],
            [
              '0x' + l1.web3.utils.asciiToHex('CxipERC721').substring(2).padStart(64, '0'),
              l1.registry.address,
              generateInitCode(['address'], [l1.deployer.address]),
            ]
          ),
          l1.salt
        );

        let cxipErc721Address = await l2.registry.getHolographedHashAddress(erc721ConfigHash);

        expect(cxipErc721Address).to.equal(zeroAddress);

        cxipErc721Address = await l1.registry.getHolographedHashAddress(erc721ConfigHash);

        let sig = await l1.deployer.signMessage(erc721ConfigHashBytes);
        let signature: Signature = StrictECDSA({
          r: '0x' + sig.substring(2, 66),
          s: '0x' + sig.substring(66, 130),
          v: '0x' + sig.substring(130, 132),
        } as Signature);

        let data: BytesLike = generateInitCode(
          ['tuple(bytes32,uint32,bytes32,bytes,bytes)', 'tuple(bytes32,bytes32,uint8)', 'address'],
          [
            [
              erc721Config.contractType,
              erc721Config.chainType,
              erc721Config.salt,
              erc721Config.byteCode,
              erc721Config.initCode,
            ],
            [signature.r, signature.s, signature.v],
            l1.deployer.address,
          ]
        );

        let originalMessagingModule = await l2.operator.getMessagingModule();
        let payload: BytesLike = await getRequestPayload(l1, l2, l1.factory.address, data);
        let gasEstimates = await getEstimatedGas(l1, l2, l1.factory.address, data, payload);
        payload = gasEstimates.payload;
        let payloadHash: string = HASH(payload);
        // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
        await l2.operator.setMessagingModule(l2.mockLZEndpoint.address);
        // make call with mockLZEndpoint AS messaging module
        await l2.mockLZEndpoint.crossChainMessage(l2.operator.address, getLzMsgGas(payload), payload, {
          gasLimit: TESTGASLIMIT,
        });
        // return messaging module back to original address
        await l2.operator.setMessagingModule(originalMessagingModule);
        let operatorJob = await l2.operator.getJobDetails(payloadHash);
        let operator = (operatorJob[2] as string).toLowerCase();
        // execute job to leave operator bonded
        await expect(
          l2.operator.connect(pickOperator(l2, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
        )
          .to.emit(l2.factory, 'BridgeableContractDeployed')
          .withArgs(cxipErc721Address, erc721ConfigHash);
        expect(await l2.registry.getHolographedHashAddress(erc721ConfigHash)).to.equal(cxipErc721Address);
      });

      it('deploy l2 equivalent on l1', async function () {
        let { erc721Config, erc721ConfigHash, erc721ConfigHashBytes } = await generateErc721Config(
          l2.network,
          l2.deployer.address,
          'CxipERC721Proxy',
          'CXIP ERC721 Collection (' + l2.hre.networkName + ')',
          'CXIP',
          1000,
          ConfigureEvents([
            HolographERC721Event.bridgeIn,
            HolographERC721Event.bridgeOut,
            HolographERC721Event.afterBurn,
          ]),
          generateInitCode(
            ['bytes32', 'address', 'bytes'],
            [
              '0x' + l2.web3.utils.asciiToHex('CxipERC721').substring(2).padStart(64, '0'),
              l2.registry.address,
              generateInitCode(['address'], [l2.deployer.address]),
            ]
          ),
          l2.salt
        );

        let cxipErc721Address = await l1.registry.getHolographedHashAddress(erc721ConfigHash);

        expect(cxipErc721Address).to.equal(zeroAddress);

        cxipErc721Address = await l2.registry.getHolographedHashAddress(erc721ConfigHash);

        let sig = await l2.deployer.signMessage(erc721ConfigHashBytes);
        let signature: Signature = StrictECDSA({
          r: '0x' + sig.substring(2, 66),
          s: '0x' + sig.substring(66, 130),
          v: '0x' + sig.substring(130, 132),
        } as Signature);

        let data: BytesLike = generateInitCode(
          ['tuple(bytes32,uint32,bytes32,bytes,bytes)', 'tuple(bytes32,bytes32,uint8)', 'address'],
          [
            [
              erc721Config.contractType,
              erc721Config.chainType,
              erc721Config.salt,
              erc721Config.byteCode,
              erc721Config.initCode,
            ],
            [signature.r, signature.s, signature.v],
            l2.deployer.address,
          ]
        );

        let originalMessagingModule = await l1.operator.getMessagingModule();
        let payload: BytesLike = await getRequestPayload(l2, l1, l2.factory.address, data);
        let gasEstimates = await getEstimatedGas(l2, l1, l2.factory.address, data, payload);
        payload = gasEstimates.payload;
        let payloadHash: string = HASH(payload);
        // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
        await l1.operator.setMessagingModule(l1.mockLZEndpoint.address);
        // make call with mockLZEndpoint AS messaging module
        await l1.mockLZEndpoint.crossChainMessage(l1.operator.address, getLzMsgGas(payload), payload, {
          gasLimit: TESTGASLIMIT,
        });
        // return messaging module back to original address
        await l1.operator.setMessagingModule(originalMessagingModule);
        let operatorJob = await l1.operator.getJobDetails(payloadHash);
        let operator = (operatorJob[2] as string).toLowerCase();
        // execute job to leave operator bonded
        await expect(
          l1.operator.connect(pickOperator(l1, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
        )
          .to.emit(l1.factory, 'BridgeableContractDeployed')
          .withArgs(cxipErc721Address, erc721ConfigHash);
        expect(await l1.registry.getHolographedHashAddress(erc721ConfigHash)).to.equal(cxipErc721Address);
      });
    });

    describe('SampleERC721', async function () {
      describe('check current state', async function () {
        it('l1 should have a total supply of 0 on l1', async function () {
          expect(await l1.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address).totalSupply()).to.equal(0);
        });

        it('l1 should have a total supply of 0 on l2', async function () {
          expect(await l2.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address).totalSupply()).to.equal(0);
        });

        it('l2 should have a total supply of 0 on l2', async function () {
          expect(await l2.sampleErc721Enforcer.attach(l2.sampleErc721Holographer.address).totalSupply()).to.equal(0);
        });

        it('l2 should have a total supply of 0 on l1', async function () {
          expect(await l1.sampleErc721Enforcer.attach(l2.sampleErc721Holographer.address).totalSupply()).to.equal(0);
        });
      });

      describe('validate mint functionality', async function () {
        it('l1 should mint token #1 as #1 on l1', async function () {
          await expect(
            l1.sampleErc721
              .attach(l1.sampleErc721Holographer.address)
              .mint(l1.deployer.address, firstNFTl1, tokenURIs[1])
          )
            .to.emit(l1.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
            .withArgs(zeroAddress, l1.deployer.address, firstNFTl1);

          gasUsage['#1 mint on l1'] = gasUsage['#1 mint on l1'].add(await getGasUsage(l1.hre));
        });

        it('l1 should mint token #1 not as #1 on l2', async function () {
          await expect(
            l2.sampleErc721
              .attach(l1.sampleErc721Holographer.address)
              .mint(l1.deployer.address, firstNFTl1, tokenURIs[1])
          )
            .to.emit(l2.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
            .withArgs(zeroAddress, l1.deployer.address, firstNFTl2);

          gasUsage['#1 mint on l2'] = gasUsage['#1 mint on l2'].add(await getGasUsage(l1.hre));
        });

        it('mint tokens #2 and #3 on l1 and l2', async function () {
          await expect(
            l1.sampleErc721
              .attach(l1.sampleErc721Holographer.address)
              .mint(l1.deployer.address, secondNFTl1, tokenURIs[2])
          )
            .to.emit(l1.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
            .withArgs(zeroAddress, l1.deployer.address, secondNFTl1);

          await expect(
            l2.sampleErc721
              .attach(l1.sampleErc721Holographer.address)
              .mint(l1.deployer.address, secondNFTl1, tokenURIs[2])
          )
            .to.emit(l2.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
            .withArgs(zeroAddress, l1.deployer.address, secondNFTl2);

          await expect(
            l1.sampleErc721
              .attach(l1.sampleErc721Holographer.address)
              .mint(l1.deployer.address, thirdNFTl1, tokenURIs[3])
          )
            .to.emit(l1.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
            .withArgs(zeroAddress, l1.deployer.address, thirdNFTl1);

          await expect(
            l2.sampleErc721
              .attach(l1.sampleErc721Holographer.address)
              .mint(l1.deployer.address, thirdNFTl1, tokenURIs[3])
          )
            .to.emit(l2.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
            .withArgs(zeroAddress, l1.deployer.address, thirdNFTl2);
        });
      });

      describe('validate bridge functionality', async function () {
        it('token #3 beaming from l1 to l2 should succeed', async function () {
          let data: BytesLike = generateInitCode(
            ['address', 'address', 'uint256'],
            [l1.deployer.address, l2.deployer.address, thirdNFTl1.toHexString()]
          );

          let originalMessagingModule = await l2.operator.getMessagingModule();
          let payload: BytesLike = await getRequestPayload(l1, l2, l1.sampleErc721Holographer.address, data);
          let gasEstimates = await getEstimatedGas(l1, l2, l1.sampleErc721Holographer.address, data, payload);
          payload = gasEstimates.payload;
          let payloadHash: string = HASH(payload);
          await l1.bridge.bridgeOutRequest(
            l2.network.holographId,
            l1.sampleErc721Holographer.address,
            gasEstimates.estimatedGas,
            GWEI,
            data,
            { value: gasEstimates.fee }
          );
          // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
          await l2.operator.setMessagingModule(l2.mockLZEndpoint.address);
          // make call with mockLZEndpoint AS messaging module
          await l2.mockLZEndpoint.crossChainMessage(l2.operator.address, getLzMsgGas(payload), payload, {
            gasLimit: TESTGASLIMIT,
          });
          // return messaging module back to original address
          await l2.operator.setMessagingModule(originalMessagingModule);
          let operatorJob = await l2.operator.getJobDetails(payloadHash);
          let operator = (operatorJob[2] as string).toLowerCase();
          // execute job to leave operator bonded
          await expect(
            l2.operator.connect(pickOperator(l2, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
          )
            .to.emit(l2.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
            .withArgs(zeroAddress, l2.deployer.address, thirdNFTl1.toHexString());

          expect(await l2.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address).ownerOf(thirdNFTl1)).to.equal(
            l2.deployer.address
          );
        });

        it('token #3 beaming from l2 to l1 should succeed', async function () {
          let data: BytesLike = generateInitCode(
            ['address', 'address', 'uint256'],
            [l2.deployer.address, l1.deployer.address, thirdNFTl2.toHexString()]
          );

          let originalMessagingModule = await l1.operator.getMessagingModule();
          let payload: BytesLike = await getRequestPayload(l2, l1, l1.sampleErc721Holographer.address, data);
          let gasEstimates = await getEstimatedGas(l2, l1, l1.sampleErc721Holographer.address, data, payload);
          payload = gasEstimates.payload;
          let payloadHash: string = HASH(payload);
          await l2.bridge.bridgeOutRequest(
            l1.network.holographId,
            l1.sampleErc721Holographer.address,
            gasEstimates.estimatedGas,
            GWEI,
            data,
            { value: gasEstimates.fee }
          );
          // temporarily set MockLZEndpoint as messaging module, to allow for easy sending
          await l1.operator.setMessagingModule(l1.mockLZEndpoint.address);
          // make call with mockLZEndpoint AS messaging module
          await l1.mockLZEndpoint.crossChainMessage(l1.operator.address, getLzMsgGas(payload), payload, {
            gasLimit: TESTGASLIMIT,
          });
          // return messaging module back to original address
          await l1.operator.setMessagingModule(originalMessagingModule);
          let operatorJob = await l1.operator.getJobDetails(payloadHash);
          let operator = (operatorJob[2] as string).toLowerCase();
          // execute job to leave operator bonded
          await expect(
            l1.operator.connect(pickOperator(l1, operator)).executeJob(payload, { gasLimit: gasEstimates.estimatedGas })
          )
            .to.emit(l1.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
            .withArgs(zeroAddress, l1.deployer.address, thirdNFTl2.toHexString());

          expect(await l1.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address).ownerOf(thirdNFTl2)).to.equal(
            l1.deployer.address
          );
        });

        /*

      it('bridge out token #3 bridge out on l1 should fail', async function () {
        let payload: BytesLike = payloadThirdNFTl1;

        await expect(
          l1.bridge.erc721out(
            l2.network.holographId,
            l1.sampleErc721Holographer.address,
            l1.deployer.address,
            l2.deployer.address,
            thirdNFTl1
          )
        ).to.be.revertedWith("HOLOGRAPH: token doesn't exist");
      });

      it('bridge out token #3 bridge out on l2 should fail', async function () {
        let payload: BytesLike = payloadThirdNFTl2;

        await expect(
          l2.bridge.erc721out(
            l1.network.holographId,
            l1.sampleErc721Holographer.address,
            l2.deployer.address,
            l1.deployer.address,
            thirdNFTl2
          )
        ).to.be.revertedWith("HOLOGRAPH: token doesn't exist");
      });

      it('bridged in token #3 bridge in on l2 should fail', async function () {
        let payload: BytesLike = payloadThirdNFTl1;

        await expect(l2.operator.executeJob(payload)).to.be.revertedWith('HOLOGRAPH: invalid job');
      });

      it('bridged in token #3 bridge in on l1 should fail', async function () {
        let payload: BytesLike = payloadThirdNFTl2;

        await expect(l1.operator.executeJob(payload)).to.be.revertedWith('HOLOGRAPH: invalid job');
      });
*/
      });
    });

    describe('Get gas calculations', async function () {
      it('SampleERC721 #1 mint on l1', async function () {
        process.stdout.write('          #1 mint on l1 gas used: ' + gasUsage['#1 mint on l1'].toString() + '\n');
        assert(!gasUsage['#1 mint on l1'].isZero(), 'zero sum returned');
      });

      it('SampleERC721 #1 mint on l2', async function () {
        process.stdout.write('          #1 mint on l2 gas used: ' + gasUsage['#1 mint on l2'].toString() + '\n');
        assert(!gasUsage['#1 mint on l2'].isZero(), 'zero sum returned');
      });

      it('SampleERC721 #1 transfer on l1', async function () {
        await expect(
          l1.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address).transfer(l1.wallet1.address, firstNFTl1)
        )
          .to.emit(l1.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
          .withArgs(l1.deployer.address, l1.wallet1.address, firstNFTl1);

        process.stdout.write('          #1 transfer on l1 gas used: ' + (await getGasUsage(l1.hre)).toString() + '\n');
      });

      it('SampleERC721 #1 transfer on l2', async function () {
        await expect(
          l2.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address).transfer(l2.wallet1.address, firstNFTl2)
        )
          .to.emit(l2.sampleErc721Enforcer.attach(l1.sampleErc721Holographer.address), 'Transfer')
          .withArgs(l2.deployer.address, l2.wallet1.address, firstNFTl2);

        process.stdout.write('          #1 transfer on l2 gas used: ' + (await getGasUsage(l2.hre)).toString() + '\n');
      });
    });

    describe('Get hToken balances', async function () {
      it('l1 hToken should have more than 0', async function () {
        let hToken = await l1.holographErc20.attach(await l1.registry.getHToken(l1.network.holographId));
        let balance = await l1.hre.ethers.provider.getBalance(hToken.address);
        process.stdout.write('          l1 hToken balance is: ' + balance + '\n');
        assert(!balance.isZero(), 'zero sum returned');
      });

      it('l2 hToken should have more than 0', async function () {
        let hToken = await l2.holographErc20.attach(await l2.registry.getHToken(l2.network.holographId));
        let balance = await l2.hre.ethers.provider.getBalance(hToken.address);
        process.stdout.write('          l2 hToken balance is: ' + balance + '\n');
        assert(!balance.isZero(), 'zero sum returned');
      });
    });
  });
});
