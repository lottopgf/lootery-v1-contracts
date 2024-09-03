import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('LooteryImplV1_3_0', (m) => ({
    looteryImpl: m.contract('Lootery', []),
}))
