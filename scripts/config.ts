export interface Config {
    [chainId: string]: {
        anyrand: `0x${string}`
        weth: `0x${string}`
        owner?: `0x${string}`
        feeRecipient?: `0x${string}`
    }
}

export const config: Config = {
    '534351': {
        /** scroll sepolia */
        anyrand: '0x86d8C50E04DDd04cdaafaC9672cf1D00b6057AF5',
        weth: '0x5300000000000000000000000000000000000004',
        owner: '0xFDbdDD397b9B643C7c28e9AeFBA8751253A320a5',
        feeRecipient: '0xFDbdDD397b9B643C7c28e9AeFBA8751253A320a5',
    },
    '534352': {
        /** scroll mainnet */
        anyrand: '0x46CFe55bf2E5A02B738f5BBdc1bDEE9Dd22b5d39',
        weth: '0x5300000000000000000000000000000000000004',
        owner: '0xF9FCDf64160087Ac1610bB1366750D55043ef206',
        feeRecipient: '0xF9FCDf64160087Ac1610bB1366750D55043ef206',
    },
}
