// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IRandomiserCallback.sol";
import "../interfaces/IAnyrand.sol";

contract MockRandomiser is IAnyrand, Ownable {
    uint256 public nextRequestId = 1;
    mapping(uint256 => address) private requestIdToCallbackMap;
    mapping(address => bool) public authorisedContracts;

    constructor() Ownable(msg.sender) {
        authorisedContracts[msg.sender] = true;
    }

    function getRequestPrice(uint256) external pure returns (uint256) {
        return 0.001 ether;
    }

    /**
     * Requests randomness
     */
    function requestRandomness(
        uint256 /** deadline */,
        uint256 /**callbackGasLimit */
    ) external payable returns (uint256) {
        uint256 requestId = nextRequestId++;
        requestIdToCallbackMap[requestId] = msg.sender;
        return requestId;
    }

    /**
     * Callback function used by VRF Coordinator (V2)
     */
    function fulfillRandomWords(
        uint256 requestId,
        uint256[] calldata randomWords
    ) external {
        require(requestId < nextRequestId, "Request ID doesn't exist");
        address callbackContract = requestIdToCallbackMap[requestId];
        delete requestIdToCallbackMap[requestId];
        IRandomiserCallback(callbackContract).receiveRandomWords(
            requestId,
            randomWords
        );
    }

    function setNextRequestId(uint256 reqId) external {
        nextRequestId = reqId;
    }
}
