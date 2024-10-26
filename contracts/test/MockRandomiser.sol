// SPDX-License-Identifier: MIT
pragma solidity ^0.8;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IRandomiserCallbackV3.sol";
import "../interfaces/IAnyrand.sol";

contract MockRandomiser is IAnyrand, Ownable {
    uint256 public nextRequestId = 1;
    mapping(uint256 => RequestState) public requestStates;
    mapping(uint256 => address) private requestIdToCallbackMap;
    mapping(address => bool) public authorisedContracts;

    constructor() Ownable(msg.sender) {
        authorisedContracts[msg.sender] = true;
    }

    function getRequestState(
        uint256 requestId
    ) external view returns (RequestState) {
        return requestStates[requestId];
    }

    function getRequestPrice(
        uint256 callbackGasLimit
    ) external pure returns (uint256, uint256) {
        return (0.001 ether, 0.001 ether / callbackGasLimit);
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
        requestStates[requestId] = RequestState.Pending;
        return requestId;
    }

    /**
     * Callback function used by VRF Coordinator (V2)
     */
    function fulfillRandomness(uint256 requestId, uint256 randomWord) external {
        address callbackContract = requestIdToCallbackMap[requestId];
        require(callbackContract != address(0), "Request ID doesn't exist");
        delete requestIdToCallbackMap[requestId];
        IRandomiserCallbackV3(callbackContract).receiveRandomness(
            requestId,
            randomWord
        );
        requestStates[requestId] = RequestState.Fulfilled;
    }

    function setNextRequestId(uint256 reqId) external {
        nextRequestId = reqId;
    }

    function setRequest(uint256 requestId, address callbackTo) external {
        requestIdToCallbackMap[requestId] = callbackTo;
    }
}
