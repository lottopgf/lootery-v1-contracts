import { ethers } from 'hardhat'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { TicketSVGRenderer, TicketSVGRenderer__factory } from '../typechain-types'
import { expect } from 'chai'
import { getBytes, toBeHex } from 'ethers'
import { shuffle } from './helpers/lotto'

describe('TicketSVG', () => {
    let deployer: SignerWithAddress
    let ticketSVGRenderer: TicketSVGRenderer
    beforeEach(async () => {
        ;[deployer] = await ethers.getSigners()
        ticketSVGRenderer = await new TicketSVGRenderer__factory(deployer).deploy()
    })

    it('should implement IERC165', async () => {
        // ERC-165
        expect(
            await ticketSVGRenderer.supportsInterface(
                getInterfaceId(['supportsInterface(bytes4)']),
            ),
        ).to.eq(true)
        // ITicketSVGRenderer
        const ticketSvgInterface = [
            'renderSVG(string,uint8,uint8[])',
            'renderTokenURI(string,uint256,uint8,uint8[])',
        ]
        expect(await ticketSVGRenderer.supportsInterface(getInterfaceId(ticketSvgInterface))).to.eq(
            true,
        )
        // Neither
        expect(
            await ticketSVGRenderer.supportsInterface(getInterfaceId(['free(palestine)'])),
        ).to.eq(false)
    })

    describe('#renderSVG', () => {
        it('should revert if len(picks) == 0', async () => {
            await expect(
                ticketSVGRenderer.renderSVG('The Lootery', 255, []),
            ).to.be.revertedWithCustomError(ticketSVGRenderer, 'EmptyPicks')
        })

        it('should render a ticket for numPick=1', async () => {
            const maxValue = 5
            const picks = [5]
            const svg = await ticketSVGRenderer.renderSVG('The Lootery', maxValue, picks)
            console.log('picks:', picks)
            console.log(`data:image/svg+xml;base64,${btoa(svg)}`)
        })

        it('should revert if value in pick is out-of-range', async () => {
            await expect(
                ticketSVGRenderer.renderSVG('The Lootery', 64, [65]),
            ).to.be.revertedWithCustomError(ticketSVGRenderer, 'OutOfRange')

            await expect(
                ticketSVGRenderer.renderSVG('The Lootery', 64, [64, 66]),
            ).to.be.revertedWithCustomError(ticketSVGRenderer, 'OutOfRange')
        })

        it('should revert is pick is unsorted', async () => {
            await expect(
                ticketSVGRenderer.renderSVG('The Lootery', 255, [5, 2, 4, 3, 1]),
            ).to.be.revertedWithCustomError(ticketSVGRenderer, 'UnsortedPick')
        })

        it('should render SVG', async () => {
            const maxValue = 26
            const pickLength = 5
            const picks = Array(pickLength)
                .fill(0)
                .map((_, i) => 1n + shuffle(BigInt(i), BigInt(maxValue), 6942069420n, 12n))
                .sort((a, b) => Number(a - b))
            const svg = await ticketSVGRenderer.renderSVG('The Lootery', maxValue, picks)
            console.log('picks:', picks)
            console.log(`data:image/svg+xml;base64,${btoa(svg)}`)
        })
    })

    describe('#renderTokenURI', () => {
        it('should render tokenURI', async () => {
            const maxValue = 26
            const pickLength = 5
            const picks = Array(pickLength)
                .fill(0)
                .map((_, i) => 1n + shuffle(BigInt(i), BigInt(maxValue), 6942069420n, 12n))
                .sort((a, b) => Number(a - b))
            const tokenURI = await ticketSVGRenderer.renderTokenURI(
                'The Lootery',
                0,
                maxValue,
                picks,
            )
            expect(tokenURI).to.match(/^data:application\/json;base64,.+$/)
        })
    })
})

function getInterfaceId(fns: string[]) {
    let interfaceId = 0n
    for (const fn of fns) {
        interfaceId ^= BigInt(ethers.solidityPackedKeccak256(['string'], [fn]))
    }
    return getBytes(toBeHex(interfaceId)).slice(0, 4)
}
