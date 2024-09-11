import type { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import 'hardhat-storage-layout'
import 'hardhat-contract-sizer'
import 'hardhat-storage-layout-changes'
import 'hardhat-abi-exporter'
import 'hardhat-gas-reporter'
import '@nomicfoundation/hardhat-ignition'
import * as dotenv from 'dotenv'

dotenv.config()

const config: HardhatUserConfig = {
    solidity: {
        version: '0.8.27',
        settings: {
            viaIR: false,
            optimizer: {
                enabled: true,
                runs: 1000,
            },
        },
    },
    networks: {
        hardhat: {
            blockGasLimit: 10_000_000,
            accounts: {
                count: 10,
            },
        },
    },
    gasReporter: {
        enabled: true,
        currency: 'USD',
        gasPrice: 1,
    },
    contractSizer: {
        alphaSort: true,
        disambiguatePaths: false,
        runOnCompile: false,
        strict: true,
    },
    paths: {
        storageLayouts: '.storage-layouts',
    },
    storageLayoutChanges: {
        contracts: [],
        fullPath: false,
    },
    abiExporter: {
        path: './exported/abi',
        runOnCompile: true,
        clear: true,
        flat: true,
        only: ['Lootery'],
        except: ['test/*'],
    },
    sourcify: {
        enabled: true,
    },
}

export default config
