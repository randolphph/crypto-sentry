export type MarketType = 'spot' | 'perpetual';

export interface DiscoveredMarket {
  marketType: MarketType;
  providerSymbol: string;
  canonicalSymbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: 'active';
}
