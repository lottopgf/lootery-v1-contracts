import { expect } from 'chai'
import { CombinationsConsumer, CombinationsConsumer__factory } from '../typechain-types'
import { ethers } from 'hardhat'
import { computePickId } from './helpers/lotto'

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
        for (let pickLength = 1; pickLength <= 7; ++pickLength) {
            const tiers = Math.ceil(pickLength / 2)
            it('should generate combinations', async () => {
                const winningPick = Array.from({ length: pickLength }, (_, i) => BigInt(i + 1))
                const winningPickId = computePickId(winningPick)
                let totalGasUsed = 0n
                for (let t = 0; t < tiers; ++t) {
                    const gasUsed = await combs.generateSubsets.staticCall(
                        winningPickId,
                        pickLength - t,
                    )
                    totalGasUsed += gasUsed
                    await combs.generateSubsets(winningPickId, pickLength - t)
                    console.log(
                        `gasUsed for tier ${t} (${pickLength - t}/${pickLength}): ${gasUsed}`,
                    )
                    const expectedCombs = genCombinations(winningPick.map(Number), pickLength - t)
                    console.log(
                        expectedCombs
                            .map((comb) => computePickId(comb.map(BigInt)))
                            .map((comb) => comb.toString(2)),
                    )
                    for (const comb of expectedCombs) {
                        const pickId = computePickId(comb.map(BigInt))
                        expect(await combs.pickIdCountsPerGame(0, pickId)).to.equal(1)
                    }
                }
                console.log(`totalGasUsed: ${totalGasUsed}`)
            })
        }
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

function genCombinationIndices(n: bigint, k: bigint): number[][] {
    const combinations = Array.from({ length: choose(Number(n), Number(k)) }, () => [] as number[])
    let c = 0
    for (let i = 0n; i < 1n << n; ++i) {
        if (BigInt(popcnt(i)) == k) {
            combinations[c] = Array.from({ length: Number(k) }, () => 0)
            let d = 0
            for (let j = 0n; j < 256n; ++j) {
                if ((i & (1n << j)) != 0n) {
                    combinations[c][d++] = Number(j)
                }
                if (BigInt(d) == k) break
            }
            c += 1
        }
    }
    return combinations
}

function genCombinations(set: number[], k: number): number[][] {
    const n = set.length
    if (n < k) throw new Error('Invalid choose')

    const combinations = genCombinationIndices(BigInt(n), BigInt(k))
    const c = combinations.length
    for (let i = 0; i < c; ++i) {
        for (let j = 0; j < k; ++j) {
            combinations[i][j] = set[combinations[i][j]]
        }
    }
    return combinations
}
