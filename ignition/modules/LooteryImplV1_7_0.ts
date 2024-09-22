import { buildModule } from '@nomicfoundation/hardhat-ignition/modules'

export default buildModule('LooteryImplV1_7_0', (m) => ({
    looteryImpl: m.contract('Lootery', []),
}))
