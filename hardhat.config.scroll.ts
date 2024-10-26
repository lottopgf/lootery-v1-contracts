import { HardhatUserConfig } from 'hardhat/types'
import config from './hardhat.config'

const configWithNetwork: HardhatUserConfig = {
    ...config,
    defaultNetwork: 'scroll',
    networks: {
        scrollSepolia: {
            chainId: 534351,
            url: process.env.SCROLL_SEPOLIA_URL as string,
            accounts: [process.env.LOOTERY_V1_SCROLL_DEPLOYER_PK as string],
        },
        scroll: {
            chainId: 534352,
            url: process.env.SCROLL_URL as string,
            accounts: [process.env.LOOTERY_V1_SCROLL_DEPLOYER_PK as string],
        },
    },
    etherscan: {
        apiKey: {
            scrollSepolia: process.env.SCROLLSCAN_API_KEY as string,
            scroll: process.env.SCROLLSCAN_API_KEY as string,
        },
        customChains: [
            {
                network: 'scrollSepolia',
                chainId: 534351,
                urls: {
                    apiURL: 'https://api-sepolia.scrollscan.com/api',
                    browserURL: 'https://sepolia.scrollscan.com',
                },
            },
            {
                network: 'scroll',
                chainId: 534352,
                urls: {
                    apiURL: 'https://api.scrollscan.com/api',
                    browserURL: 'https://scrollscan.com',
                },
            },
        ],
    },
}

export default configWithNetwork
