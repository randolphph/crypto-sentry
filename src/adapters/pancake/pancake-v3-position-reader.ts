import { getAddress } from 'viem';

import {
  UniswapV3PositionReader,
  type UniswapV3Deployment,
  type UniswapV3PositionReaderOptions,
} from '../uniswap/uniswap-v3-position-reader.js';

export const BSC_PANCAKE_V3: UniswapV3Deployment = {
  chainId: 56,
  chainName: 'BNB Smart Chain',
  rpcUrl: '',
  explorerUrl: 'https://bscscan.com',
  deploymentBlock: 26_956_207n,
  factoryAddress: getAddress('0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'),
  positionManagerAddress: getAddress('0x46A15B0b27311cedF172AB29E4f4766fbE7F4364'),
};

export const supportedPancakeV3Deployments = new Map<number, UniswapV3Deployment>([
  [BSC_PANCAKE_V3.chainId, BSC_PANCAKE_V3],
]);

export class PancakeV3PositionReader extends UniswapV3PositionReader {
  public constructor(options: UniswapV3PositionReaderOptions) {
    const deployment = supportedPancakeV3Deployments.get(options.expectedChainId);
    super({ ...options, ...(deployment === undefined ? {} : { deployment }), protocol: 'pancakeswap' });
  }
}
