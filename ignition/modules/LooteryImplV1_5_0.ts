import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('LooteryImplV1_5_0', (m) => ({
    looteryImpl: m.contract('Lootery', []),
}))
