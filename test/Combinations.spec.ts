import { expect } from 'chai'
import { CombinationsConsumer, CombinationsConsumer__factory } from '../typechain-types'
import { ethers } from 'hardhat'
import { computePick, computePickId } from './helpers/lotto'

describe.only('Combinations', () => {
    let combs: CombinationsConsumer
    beforeEach(async () => {
        const [deployer] = await ethers.getSigners()
        combs = await new CombinationsConsumer__factory(deployer).deploy()
    })

    describe('#choose', () => {
        it('should compute binomial coefficient', async () => {
            const n = 128
            const k = 127
            const { out, gasUsed } = await combs.choose(n, k)
            console.log(`${n} choose ${k} = ${out}`)
            console.log(`gasUsed: ${gasUsed}`)
        })
    })

    describe('#genCombinations', () => {
        it('should generate 7 choose 5 combinations', async () => {
            const tier = 2
            const pickLength = 7
            const winningPickId = Array.from(
                { length: pickLength },
                (_, i) => 1n << BigInt(i + 1),
            ).reduce((acc, cur) => acc | cur, 0n)
            console.log(`winningPickId: ${winningPickId.toString(2)}`)
            const { out, gasUsed } = await combs.generateSubsets(winningPickId, pickLength - tier)

            // (pickLength-tier)/pickLength
            const set = new Set<bigint>()
            for (const comb of out) {
                set.add(comb)
                console.log(`${comb.toString(2)} (${popcnt(comb)})`)
                expect(popcnt(comb)).to.equal(pickLength - tier)
            }
            expect(set.size).to.equal(choose(pickLength, pickLength - tier))
            console.log(`gasUsed: ${gasUsed}`)
        })
    })
})

// Simple, naive, foolproof popcnt
function popcnt(n: bigint): number {
    let count = 0
    while (n > 0n) {
        count += Number(n & 1n)
        n >>= 1n
    }
    return count
}

function choose(n: number, k: number): number {
    if (n < k || n > 128) throw new Error('Invalid input')
    // "How to calculate binomial coefficients"
    // From: https://blog.plover.com/math/choose.html
    // This algorithm computes multiplication and division in alternation
    // to avoid overflow as much as possible.
    let out = 1n
    for (let d = 1n; d <= k; ++d) {
        out *= BigInt(n--)
        out /= d
    }
    return Number(out)
}
