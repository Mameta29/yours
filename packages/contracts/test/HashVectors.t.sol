// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {IPurchaseGateV1 as I} from "../src/IPurchaseGateV1.sol";
import {GateHash} from "../src/GateHash.sol";
contract HashVectorsTest {
    function testPurchaseOrderReferenceVector() public pure {
        I.PurchaseOrder memory value = I.PurchaseOrder(0x00000000000000000000000000000000000000000000000000000000000003e9, 0x00000000000000000000000000000000000000000000000000000000000003ea, 0x0000000000000000000000000000000000000000000000000000000000000064, 1, 0, address(100), address(101), 0x0000000000000000000000000000000000000000000000000000000000000001, address(200), address(301), 2000000000000000000000, 0x000000000000000000000000000000000000000000000000000000000000006f, 0xd350329df83d75bfec5201b192c32211791eb1e0327fae6e99d1fd096fdb792e, 0x11de7f245625ef0c9a1846dd4bac4edbe381299df221ea9791592b9d376553ab, 1790381100);
        require(GateHash.hash(value) == 0x4c2c71c0c93ef6c7fdf1ad527770dd5c775368cf93b9c5528c4261a27bfcf483, "reference hash mismatch");
    }
    function testFundingReferenceVector() public pure {
        I.Funding memory value = I.Funding(address(300), 15000000, 2000000000000000000000, address(500), 0x000000000000000000000000000000000000000000000000000000000000022b, 1790381100);
        require(GateHash.hash(value) == 0xd350329df83d75bfec5201b192c32211791eb1e0327fae6e99d1fd096fdb792e, "reference hash mismatch");
    }
    function testExecutionIntentReferenceVector() public pure {
        I.ExecutionIntent memory value = I.ExecutionIntent(0x062f27020d3b7edc874147ac5b1ac4b1e92fab065975e785cfe2e18f0008a1b4, 0x0000000000000000000000000000000000000000000000000000000000000065, 0x0000000000000000000000000000000000000000000000000000000000000066, 1790381100);
        require(GateHash.hash(value) == 0x2f077dbdd183b899b83dd937c3d256e5fc8374f8761540888e25f6b1e9a2e673, "reference hash mismatch");
    }
    function testRiskStampReferenceVector() public pure {
        I.RiskStamp memory value = I.RiskStamp(0xaf4f2919b7b72987ba1ffb46b18cd2a9d3def516c9facfa0839064b2cc0857c3, 0x00000000000000000000000000000000000000000000000000000000000002bc, 0x000000000000000000000000000000000000000000000000000000000000006f, 64, 1790380801, 1790380861);
        require(GateHash.hash(value) == 0xc45e8bce4b824b063218894d7ed2970a76ae2871396adbe3919f22ec8076c1c6, "reference hash mismatch");
    }
    function testPriceStampReferenceVector() public pure {
        I.PriceStamp memory value = I.PriceStamp(0x062f27020d3b7edc874147ac5b1ac4b1e92fab065975e785cfe2e18f0008a1b4, address(300), 14000000, 0x0000000000000000000000000000000000000000000000000000000000000067, 5, 6);
        require(GateHash.hash(value) == 0x4893ab48eef2c25ae11648bcaf79b132dcfdc06a467d11c668c3c54cd62d44ab, "reference hash mismatch");
    }
    function testHumanApprovalReferenceVector() public pure {
        I.HumanApproval memory value = I.HumanApproval(0x0000000000000000000000000000000000000000000000000000000000000384, 0xaf4f2919b7b72987ba1ffb46b18cd2a9d3def516c9facfa0839064b2cc0857c3, 0x00000000000000000000000000000000000000000000000000000000000002bc, 0x0000000000000000000000000000000000000000000000000000000000000070, 66, 1790380801, 1790380861);
        require(GateHash.hash(value) == 0x37098c3756737ae07eff95a6db710b1a0f8715d25dde73f3b1691385088adb32, "reference hash mismatch");
    }
    function testPurchaseResultReferenceVector() public pure {
        I.PurchaseResult memory value = I.PurchaseResult(0x0000000000000000000000000000000000000000000000000000000000000064, 2, 3, 4, 5);
        require(GateHash.hash(value) == 0x3050eea925dcb3501449b863d0f592bf68d52c8309df5ce59cab2dfcb98923af, "reference hash mismatch");
    }
    function testPolicyReferenceVector() public pure {
        I.Policy memory value = I.Policy(address(100), 0x0000000000000000000000000000000000000000000000000000000000000064, 1, 1790380800, 1792972800, 1790380800, 2592000, 3000000000000000000000, 10000000000000000000000, 0x59c3a67ade4943ba77540a793216d37c12f46b244175e42833064941922a9d1c, 0xced27a5910ae4096e27d27e188d690de9ea976bd782df3bb295c42584d048ed0, 0x000000000000000000000000000000000000000000000000000000000000006f, 0x0000000000000000000000000000000000000000000000000000000000000070, 0xc1d1c776f6370d05f1d47e28797181dd07963bfe4e3aa2c731a0d3caea43fa4b, 200, 255, address(116), address(117), address(118), address(119));
        require(GateHash.hash(value) == 0x175aefafcf92e44ffa6f8bc2c45ac31621030f369338b51058d3f0a007ccd1f3, "reference hash mismatch");
    }
    function testMerchantReferenceVector() public pure {
        I.Merchant memory value = I.Merchant(0x0000000000000000000000000000000000000000000000000000000000000064, address(101));
        require(GateHash.hash(value) == 0x7832f65604f12c8cf824ca0bbce6667f359d7c7703b959c408600bc565b07fe4, "reference hash mismatch");
    }
    function testAssetLimitReferenceVector() public pure {
        I.AssetLimit memory value = I.AssetLimit(address(100), 2, 3);
        require(GateHash.hash(value) == 0xb13251bfd3062493b9f34583f60c686690f5a4af4cf1cb8035f66d870986a1f2, "reference hash mismatch");
    }
    function testGrantBindingReferenceVector() public pure {
        I.GrantBinding memory value = I.GrantBinding(0x0000000000000000000000000000000000000000000000000000000000000064, 1, address(101), address(300), 0x0000000000000000000000000000000000000000000000000000000000000068, 1792972800);
        require(GateHash.hash(value) == 0xc542c9d6db29dba0bf0c06fd84d28b0e8c92a0853f4f8f5cf3a569afd2812dc3, "reference hash mismatch");
    }
}
