// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import {ITicketSVGRenderer} from "../interfaces/ITicketSVGRenderer.sol";
import {IERC165, ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

contract TicketSVGRenderer is ITicketSVGRenderer, ERC165 {
    using Strings for uint256;

    uint256 private constant NUMBERS_PER_ROW = 5;
    uint256 private constant ROW_HEIGHT = 38;

    /// @notice See {IERC165-supportsInterface}.
    function supportsInterface(
        bytes4 interfaceId
    ) public view override(IERC165, ERC165) returns (bool) {
        return
            interfaceId == type(ITicketSVGRenderer).interfaceId ||
            super.supportsInterface(interfaceId);
    }

    /// @notice See {ITicketSVGRenderer-renderSVG}.
    function renderSVG(
        string memory name,
        uint8 maxPick,
        uint8[] memory pick
    ) public pure returns (string memory) {
        uint256 rows = (maxPick / NUMBERS_PER_ROW) +
            (maxPick % NUMBERS_PER_ROW == 0 ? 0 : 1);
        uint256 positionY = 75;
        uint256 p; // pointer for picks
        string memory gridSVG;
        for (uint256 r; r < rows; ++r) {
            uint256 positionX = 30;
            uint256 cols = r * NUMBERS_PER_ROW + NUMBERS_PER_ROW > maxPick
                ? maxPick % 5
                : NUMBERS_PER_ROW;
            for (uint256 c; c < cols; ++c) {
                uint256 num = r * NUMBERS_PER_ROW + c + 1;
                if (p < pick.length && pick[p] == num) {
                    p += 1;
                    gridSVG = string(
                        abi.encodePacked(
                            gridSVG,
                            "<circle cx='",
                            (positionX + 20).toString(),
                            "' cy='",
                            (positionY - 6).toString(),
                            "' r='15' stroke='red' fill='none' />"
                        )
                    );
                }
                gridSVG = string(
                    abi.encodePacked(
                        gridSVG,
                        "<text x='",
                        (positionX + 20).toString(),
                        "' y='",
                        positionY.toString(),
                        "' text-anchor='middle' font-family='Arial' font-size='16' fill='black'>",
                        num.toString(),
                        "</text>"
                    )
                );

                positionX += 50;
            }
            positionY += ROW_HEIGHT;
        }

        uint256 height = (75 + (rows * ROW_HEIGHT));
        string memory svgHeader = string(
            abi.encodePacked(
                "<svg xmlns='http://www.w3.org/2000/svg' version='1.1' width='300' height='",
                height.toString(),
                "'>"
            )
        );
        string memory svgFooter = "</svg>";
        string memory svgBody = string(
            abi.encodePacked(
                "<rect width='300' height='",
                height.toString(),
                "' fill='white' stroke='black' />",
                "<text x='150' y='30' text-anchor='middle' font-family='Arial' font-size='20' font-weight='bold' fill='black'>",
                name,
                "</text>",
                gridSVG
            )
        );
        return string(abi.encodePacked(svgHeader, svgBody, svgFooter));
    }

    /// @notice See {ITicketSVGRenderer-renderTokenURI}.
    function renderTokenURI(
        string memory name,
        uint256 tokenId,
        uint8 maxPick,
        uint8[] memory pick
    ) external pure returns (string memory) {
        return
            string(
                abi.encodePacked(
                    "data:application/json;base64,",
                    Base64.encode(
                        bytes(
                            abi.encodePacked(
                                '{"name":"',
                                name,
                                " Ticket #",
                                tokenId.toString(),
                                '", "description":"POWERBALD LOL", "image": "',
                                "data:image/svg+xml;base64,",
                                Base64.encode(
                                    bytes(renderSVG(name, maxPick, pick))
                                ),
                                '"}'
                            )
                        )
                    )
                )
            );
    }
}
