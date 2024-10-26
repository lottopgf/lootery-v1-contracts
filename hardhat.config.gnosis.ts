import { HardhatUserConfig } from 'hardhat/types'
import config from './hardhat.config'

const configWithNetwork: HardhatUserConfig = {
    ...config,
    defaultNetwork: 'gnosis',
    networks: {
        gnosis: {
            chainId: 100,
            url: process.env.XDAI_URL as string,
            accounts: [process.env.LOOTERY_V1_GNOSIS_DEPLOYER_PK as string],
        },
    },
    etherscan: {
        apiKey: {
            xdai: process.env.GNOSISSCAN_API_KEY as string,
        },
    },
}

export default configWithNetwork
