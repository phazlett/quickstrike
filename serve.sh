#!/bin/bash
echo "Starting SPY Trader at http://localhost:5500"
python3 -m http.server 5500 --bind localhost
