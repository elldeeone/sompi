#!/usr/bin/env python3
"""Pinned AP2 v0.2 Python half of Sompi's cross-language fixture.

This file deliberately imports the SDK from the exact upstream checkout
selected by the runner. It emits no keys, tokens, or receipt bodies.
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
from typing import Literal

from ap2.sdk import mandate as mandate_module
from ap2.sdk.disclosure_metadata import DisclosureMetadata
from ap2.sdk.generated.checkout_mandate import CheckoutMandate
from ap2.sdk.generated.payment_mandate import PaymentMandate
from ap2.sdk.generated.types.amount import Amount
from ap2.sdk.generated.types.merchant import Merchant
from ap2.sdk.generated.types.payment_instrument import PaymentInstrument
from ap2.sdk.jwt_helper import verify_jwt
from ap2.sdk.mandate import MandateClient
from ap2.sdk.receipt_wrapper import ReceiptClient
from ap2.sdk.sdjwt import common
from jwcrypto.jwk import JWK
from pydantic import ConfigDict, Field


# The pinned SDK's facade logs operation metadata beside its source checkout.
# Conformance runs are intentionally read-only and keep even token-free logs out
# of both the checkout and process output.
mandate_module.LOG_FILE_PATH = os.devnull

expected_source_root = os.environ.get('SOMPI_AP2_SOURCE_ROOT')
if not expected_source_root:
    raise RuntimeError('SOMPI_AP2_SOURCE_ROOT is required')
expected_mandate_module = (
    pathlib.Path(expected_source_root)
    / 'code/sdk/python/ap2/sdk/mandate.py'
).resolve()
if pathlib.Path(mandate_module.__file__).resolve() != expected_mandate_module:
    raise RuntimeError('AP2 Python SDK was not imported from the pinned checkout')


class NativeKasPaymentInstrument(PaymentInstrument):
    """The adapter-local experimental KAS fields recorded in ADR-0010."""

    model_config = ConfigDict(extra='forbid', populate_by_name=True)

    network: Literal['kaspa:testnet-10']
    asset: Literal['KAS']
    atomic_unit: Literal['sompi'] = Field(alias='atomicUnit')
    decimals: Literal[8]
    scheme: Literal['exact']


class NativeKasPaymentMandate(PaymentMandate):
    """Pinned AP2 Payment Mandate plus Sompi's isolated native-KAS profile."""

    model_config = ConfigDict(extra='forbid')

    payment_instrument: NativeKasPaymentInstrument


def read_json(path: pathlib.Path) -> dict:
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict):
        raise ValueError(f'{path.name} must contain one JSON object')
    return value


def write_json(path: pathlib.Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n',
        encoding='utf-8',
    )
    path.chmod(0o600)


def jwk(value: dict) -> JWK:
    return JWK.from_json(json.dumps(value, sort_keys=True))


def public_jwk(value: dict) -> JWK:
    return jwk({key: item for key, item in value.items() if key != 'd'})


def issuer_reference(token: str) -> str:
    return common.compute_issuer_jwt_hash(common.parse_token(token))


def verify_typescript(input_value: dict, fixture: dict) -> tuple[str, str]:
    if input_value.get('schemaVersion') != 1:
        raise ValueError('TypeScript bridge schema is not version 1')
    checkout = input_value['checkout']
    artifacts = input_value['typescriptIssued']
    expected = fixture['expected']
    authority_key = public_jwk(fixture['authority']['privateJwk'])
    current_time = fixture['nowSec'] + 21

    checkout_mandate = MandateClient().verify(
        token=artifacts['checkoutMandate'],
        key_or_provider=authority_key,
        payload_type=CheckoutMandate,
        clock_skew_seconds=0,
        current_time=current_time,
    ).mandate_payload
    payment_mandate = MandateClient().verify(
        token=artifacts['paymentMandate'],
        key_or_provider=authority_key,
        payload_type=NativeKasPaymentMandate,
        clock_skew_seconds=0,
        current_time=current_time,
    ).mandate_payload

    if checkout_mandate.checkout_jwt != checkout['artifact']:
        raise ValueError('TypeScript Checkout Mandate changed checkout_jwt bytes')
    if checkout_mandate.checkout_hash != checkout['checkoutHash']:
        raise ValueError('TypeScript Checkout Mandate changed checkout_hash')
    if payment_mandate.transaction_id != checkout['checkoutHash']:
        raise ValueError('TypeScript Payment Mandate is not joined to Checkout')
    if payment_mandate.payee.model_dump(exclude_none=True) != {
        'id': expected['merchantId'],
        'name': expected['merchantName'],
        'website': expected['merchantWebsite'],
    }:
        raise ValueError('TypeScript Payment Mandate changed the AP2 payee')
    if payment_mandate.payment_amount.model_dump() != {
        'amount': expected['amountAtomic'],
        'currency': expected['currency'],
    }:
        raise ValueError('TypeScript Payment Mandate changed the AP2 amount')
    instrument = payment_mandate.payment_instrument.model_dump(
        by_alias=True,
        exclude_none=True,
    )
    if instrument != {
        'id': fixture['instrumentId'],
        'type': expected['instrumentType'],
        'description': 'Native KAS via Kaspa-x402 exact',
        'network': expected['network'],
        'asset': expected['asset'],
        'atomicUnit': expected['atomicUnit'],
        'decimals': expected['decimals'],
        'scheme': expected['scheme'],
    }:
        raise ValueError('TypeScript Payment Mandate changed the native-KAS profile')

    checkout_reference = issuer_reference(artifacts['checkoutMandate'])
    payment_reference = issuer_reference(artifacts['paymentMandate'])
    receipts = ReceiptClient()
    checkout_result = receipts.verify_receipt(
        artifacts['checkoutReceipt'],
        jwk(fixture['merchantReceipt']['publicJwk']),
        has_reference_in_store_cb=lambda value: value == checkout_reference,
        is_payment_receipt=False,
    )
    payment_result = receipts.verify_receipt(
        artifacts['paymentReceipt'],
        jwk(fixture['paymentReceipt']['publicJwk']),
        has_reference_in_store_cb=lambda value: value == payment_reference,
        is_payment_receipt=True,
    )
    if checkout_result != {'verified': True} or payment_result != {'verified': True}:
        raise ValueError('pinned Python ReceiptClient rejected a TypeScript receipt')

    checkout_receipt = verify_jwt(
        artifacts['checkoutReceipt'], jwk(fixture['merchantReceipt']['publicJwk'])
    )
    payment_receipt = verify_jwt(
        artifacts['paymentReceipt'], jwk(fixture['paymentReceipt']['publicJwk'])
    )
    if checkout_receipt.get('reference') != checkout_reference:
        raise ValueError('Checkout Receipt reference is not the issuer-JWT hash')
    if payment_receipt.get('reference') != payment_reference:
        raise ValueError('Payment Receipt reference is not the issuer-JWT hash')
    if checkout_receipt.get('order_id') != expected['checkoutOrderId']:
        raise ValueError('Checkout Receipt order ID changed')
    if (
        payment_receipt.get('payment_id') != expected['paymentId']
        or payment_receipt.get('psp_confirmation_id') != expected['pspConfirmationId']
        or payment_receipt.get('network_confirmation_id')
        != expected['networkConfirmationId']
    ):
        raise ValueError('Payment Receipt confirmation identity changed')
    return checkout_reference, payment_reference


def issue_python(input_value: dict, fixture: dict) -> dict:
    checkout = input_value['checkout']
    expected = fixture['expected']
    authority_key = jwk(fixture['authority']['privateJwk'])
    iat = fixture['nowSec'] + 10
    exp = fixture['expiresAtSec']

    checkout_content = CheckoutMandate(
        checkout_jwt=checkout['artifact'],
        checkout_hash=checkout['checkoutHash'],
        iat=iat,
        exp=exp,
    )
    checkout_sd = DisclosureMetadata(
        sd_keys=['checkout_jwt'],
    )
    checkout_mandate = MandateClient().create(
        payloads=[checkout_content],
        issuer_key=authority_key,
        sd=checkout_sd,
    )

    payment_content = NativeKasPaymentMandate(
        transaction_id=checkout['checkoutHash'],
        payee=Merchant(
            id=expected['merchantId'],
            name=expected['merchantName'],
            website=expected['merchantWebsite'],
        ),
        payment_amount=Amount(
            amount=expected['amountAtomic'],
            currency=expected['currency'],
        ),
        payment_instrument=NativeKasPaymentInstrument(
            id=fixture['instrumentId'],
            type=expected['instrumentType'],
            description='Native KAS via Kaspa-x402 exact',
            network=expected['network'],
            asset=expected['asset'],
            atomicUnit=expected['atomicUnit'],
            decimals=expected['decimals'],
            scheme=expected['scheme'],
        ),
        iat=iat,
        exp=exp,
    )
    payment_mandate = MandateClient().create(
        payloads=[payment_content],
        issuer_key=authority_key,
        sd=DisclosureMetadata(),
    )
    return {
        'schemaVersion': 1,
        'fixtureId': fixture['fixtureId'],
        'pythonIssued': {
            'checkoutMandate': checkout_mandate,
            'paymentMandate': payment_mandate,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--fixture', type=pathlib.Path, required=True)
    parser.add_argument('--input', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    args = parser.parse_args()

    fixture = read_json(args.fixture)
    input_value = read_json(args.input)
    verify_typescript(input_value, fixture)
    write_json(args.output, issue_python(input_value, fixture))


if __name__ == '__main__':
    main()
