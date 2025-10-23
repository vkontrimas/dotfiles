#!/usr/bin/env python3
"""
Perforce File Flag Checker
This script lists all files in Perforce and identifies those with the +w (writable) flag set.
"""

import subprocess
import sys
import re
import argparse
from tqdm import tqdm


def run_p4_command(command):
    """
    Execute a p4 command and return the output.
    
    Args:
        command: List of command arguments to pass to p4
        
    Returns:
        String output from the command
    """
    try:
        result = subprocess.run(
            ['p4'] + command,
            capture_output=True,
            text=True,
            check=True
        )
        return result.stdout
    except subprocess.CalledProcessError as e:
        print(f"Error running p4 command: {e}", file=sys.stderr)
        print(f"stderr: {e.stderr}", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("Error: p4 command not found. Please ensure Perforce is installed and in your PATH.", file=sys.stderr)
        sys.exit(1)


def get_all_depot_files(depot_path="//..."):
    """
    Get all files from the specified depot path.
    
    Args:
        depot_path: The depot path to search (default: //... for all files)
        
    Returns:
        List of file paths
    """
    print(f"Fetching files from {depot_path}...")
    output = run_p4_command(['files', depot_path])
    
    files = []
    for line in output.strip().split('\n'):
        if line:
            # Parse the file path from lines like: //depot/path/file.txt#1 - add change 123 (text)
            match = re.match(r'^(.+?)#\d+\s+-\s+', line)
            if match:
                files.append(match.group(1))
    
    return files


def check_file_flags(file_path):
    """
    Check if a file has the +w flag set.
    
    Args:
        file_path: The depot file path to check
        
    Returns:
        Tuple of (has_writable_flag, file_type_string)
    """
    try:
        output = run_p4_command(['fstat', '-T', 'headType', file_path])
        
        # Parse the headType field
        for line in output.strip().split('\n'):
            if line.startswith('... headType'):
                file_type = line.split(' ', 2)[2]
                # Check if +w flag is present in the file type
                has_writable = '+w' in file_type
                return has_writable, file_type
                
    except Exception as e:
        print(f"Warning: Could not check flags for {file_path}: {e}", file=sys.stderr)
    
    return False, None


def main():
    """Main function to find all files with +w flag."""
    
    # Set up argument parser
    parser = argparse.ArgumentParser(
        description='Find all Perforce files with the +w (writable) flag set on the server.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                          # Check all files in depot
  %(prog)s //depot/main/...         # Check specific depot path
  %(prog)s -o results.txt           # Save to custom output file
  %(prog)s //depot/main/... -o my_files.txt
        """
    )
    
    parser.add_argument(
        'depot_path',
        nargs='?',
        default='//...',
        help='Depot path to search (default: //...)'
    )
    
    parser.add_argument(
        '-o', '--output',
        default='p4_writable_files.txt',
        help='Output file for results (default: p4_writable_files.txt)'
    )
    
    args = parser.parse_args()
    
    print("Perforce Writable File Finder")
    print("=" * 50)
    
    # Get all files
    all_files = get_all_depot_files(args.depot_path)
    print(f"Found {len(all_files)} files in depot")
    
    # Check each file for +w flag
    writable_files = []
    
    for file_path in tqdm(all_files, desc="Checking file flags", unit="file"):
        has_writable, file_type = check_file_flags(file_path)
        if has_writable:
            writable_files.append((file_path, file_type))
    
    # Display results
    print("\n" + "=" * 50)
    print(f"Files with +w flag: {len(writable_files)}")
    print("=" * 50)
    
    if writable_files:
        for file_path, file_type in writable_files:
            print(f"{file_path} ({file_type})")
    else:
        print("No files found with +w flag")
    
    # Optionally save to file
    if writable_files:
        with open(args.output, 'w') as f:
            for file_path, file_type in writable_files:
                f.write(f"{file_path} ({file_type})\n")
        print(f"\nResults saved to {args.output}")


if __name__ == "__main__":
    main()
